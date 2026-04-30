import { withAuth } from "@workos-inc/authkit-nextjs"
import OpenAI from "openai"
import { z } from "zod"

import { loadIconCatalog } from "@/lib/canvas-ai/icon-catalog"
import { buildCanvasPrompts } from "@/lib/canvas-ai/prompts"
import { checkRateLimit } from "@/lib/canvas-ai/rate-limit"
import { CanvasStreamExtractor } from "@/lib/canvas-ai/stream-parser"

export const runtime = "nodejs"
// Allow long-running streams without Vercel's default 10s function cap.
export const maxDuration = 300

const positionSchema = z.object({ x: z.number(), y: z.number() }).optional()

const nodeContextSchema = z.object({
  id: z.string(),
  kind: z.enum(["icon", "group", "text"]),
  label: z.string(),
  iconId: z.string().optional(),
  parentId: z.string().optional(),
  position: positionSchema,
})

const edgeContextSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  method: z.string().optional(),
})

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
})

const requestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  projectName: z.string().max(200).optional(),
  nodes: z.array(nodeContextSchema).max(500).default([]),
  edges: z.array(edgeContextSchema).max(800).default([]),
  selectedNodeIds: z.array(z.string()).max(200).default([]),
  history: z.array(messageSchema).max(40).optional(),
})

/**
 * Streaming SSE endpoint for the canvas-ai agent.
 *
 * Talks to Azure OpenAI's Responses API and forwards a small protocol the
 * client uses to:
 *   - render the assistant's `reply` markdown as it arrives, AND
 *   - apply individual canvas mutation `op`s the moment the model finishes
 *     emitting each one (instead of waiting for the full JSON to land).
 *
 * Wire format (each event is `data: <json>\n\n`):
 *   { type: "status", stage: "started"|"thinking"|"writing" }
 *   { type: "reply",  delta: "…" }              // append to assistant message
 *   { type: "op",     op: { op: "add_node", … } } // apply on the canvas
 *   { type: "done",   reply: "…", ops: [...] }  // final canonical result
 *   { type: "error",  message: "…"        }
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonError(400, "Invalid JSON body")
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, "Invalid request payload")
  }

  let userId: string
  try {
    const { user } = await withAuth({ ensureSignedIn: true })
    userId = user.id
  } catch {
    return jsonError(401, "Not authenticated")
  }

  const rl = checkRateLimit(userId)
  if (!rl.ok) {
    return jsonError(
      429,
      `Rate limit exceeded. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
    )
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT
  const apiKey = process.env.AZURE_OPENAI_API_KEY
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.2-chat"
  if (!endpoint || !apiKey) {
    return jsonError(500, "AI service not configured")
  }

  // Reasoning models (gpt-5.x-pro family) need an explicit effort level.
  // Non-reasoning deployments reject this parameter, so only set it when
  // explicitly opted in.
  const reasoningEffort = process.env.AZURE_OPENAI_REASONING_EFFORT as
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | undefined

  const iconCatalog = await loadIconCatalog()

  const { systemPrompt, userPrompt } = buildCanvasPrompts({
    prompt: parsed.data.prompt,
    nodes: parsed.data.nodes,
    edges: parsed.data.edges,
    selectedNodeIds: parsed.data.selectedNodeIds,
    iconCatalog,
    history: parsed.data.history,
    projectName: parsed.data.projectName,
  })

  const client = new OpenAI({
    baseURL: `${endpoint.replace(/\/+$/, "")}/openai/v1`,
    apiKey,
    defaultHeaders: { "api-key": apiKey },
  })

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (event: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          )
        } catch {
          /* controller already closed */
        }
      }

      // SSE keep-alive — proxies / browsers will drop a connection that
      // sits idle for 30s+ while a reasoning model thinks.
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(": ping\n\n"))
        } catch {
          /* ignore */
        }
      }, 10_000)

      send({ type: "status", stage: "started" })

      const extractor = new CanvasStreamExtractor()
      let fullText = ""

      try {
        const responseStream = await client.responses.create({
          model: deployment,
          stream: true,
          ...(reasoningEffort
            ? { reasoning: { effort: reasoningEffort } }
            : {}),
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        })

        let firstToken = true
        for await (const evt of responseStream as AsyncIterable<
          Record<string, unknown>
        >) {
          const type = String(evt.type ?? "")
          if (
            type === "response.output_text.delta" &&
            typeof evt.delta === "string"
          ) {
            if (firstToken) {
              send({ type: "status", stage: "writing" })
              firstToken = false
            }
            fullText += evt.delta
            const partial = extractor.push(evt.delta)
            if (partial.replyDelta) {
              send({ type: "reply", delta: partial.replyDelta })
            }
            for (const op of partial.ops) {
              send({ type: "op", op })
            }
          } else if (type === "response.in_progress") {
            send({ type: "status", stage: "thinking" })
          } else if (
            type === "response.completed" &&
            !fullText.trim()
          ) {
            // Some Azure deployments only emit a single completion event
            // with the full text. Backfill so the client still gets ops.
            const resp = evt.response as Record<string, unknown> | undefined
            if (typeof resp?.output_text === "string") {
              fullText = resp.output_text
              const partial = extractor.push(resp.output_text)
              if (partial.replyDelta) {
                send({ type: "reply", delta: partial.replyDelta })
              }
              for (const op of partial.ops) {
                send({ type: "op", op })
              }
            }
          } else if (
            type === "error" ||
            type === "response.error" ||
            type === "response.failed"
          ) {
            const err = evt.error as Record<string, unknown> | undefined
            const msg =
              (typeof evt.message === "string" ? evt.message : "") ||
              (typeof err?.message === "string" ? err.message : "") ||
              "AI service error"
            throw new Error(msg)
          }
        }

        if (!fullText.trim()) {
          send({ type: "error", message: "Empty response from AI service" })
        } else {
          const final = extractor.final()
          send({ type: "done", reply: final.reply, ops: final.ops })
        }
      } catch (err) {
        console.error("Canvas AI stream error:", err)
        let message = "Stream interrupted"
        if (err instanceof OpenAI.APIError) {
          message = `${err.status ?? "API"} — ${err.message}`
        } else if (err instanceof Error) {
          message = err.message
        }
        send({ type: "error", message })
      } finally {
        clearInterval(heartbeat)
        closed = true
        try {
          controller.close()
        } catch {
          /* ignore */
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
