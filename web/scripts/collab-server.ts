/**
 * Codesign collaborative server.
 *
 * Run with:
 *   bun run dev:ws
 *
 * This single Bun process serves two things on the same TCP port:
 *
 *   1. A Hocuspocus websocket server (Yjs sync + awareness), with documents
 *      persisted to Supabase Postgres via @hocuspocus/extension-database.
 *      The browser uses @hocuspocus/provider, NOT y-websocket — Hocuspocus 4
 *      embeds the document name inside its protocol messages and is not
 *      wire-compatible with the legacy y-websocket server.
 *
 *   2. A small HTTP REST API consumed by the Next app to list / create /
 *      look up projects (rooms). Keeping it on the same port means there's
 *      one URL to configure (NEXT_PUBLIC_COLLAB_HTTP_URL ===
 *      NEXT_PUBLIC_COLLAB_WS_URL host).
 *
 * Environment:
 *   COLLAB_WS_PORT (default 1234)
 *   COLLAB_WS_HOST (default 0.0.0.0)
 *   SUPABASE_URL                  — required
 *   SUPABASE_SERVICE_ROLE_KEY     — required (server-to-server, never ship
 *                                    this to the browser)
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { Database } from "@hocuspocus/extension-database"
import { Hocuspocus } from "@hocuspocus/server"
import { createClient } from "@supabase/supabase-js"
import { WebSocketServer } from "ws"

import { closeAllCachedConnections } from "../lib/flow-core/document"
import { mountAgentBridge } from "./agent-bridge/routes"

const PORT = Number(process.env.COLLAB_WS_PORT ?? 1234)
const HOST = process.env.COLLAB_WS_HOST ?? "0.0.0.0"

// ---- Agent bridge mount-time gate -------------------------------------------
// Loopback-only deployments may run open (no secret); any other bind host must
// configure CODESIGN_AGENT_BRIDGE_SECRET (>= 16 chars) or the bridge mounts in
// a disabled state that returns 503 BRIDGE_DISABLED for every agent route.

const wsHost = process.env.COLLAB_WS_HOST ?? "127.0.0.1"
const isLoopback =
  wsHost === "127.0.0.1" || wsHost === "localhost" || wsHost === "::1"
const bridgeSecret = process.env.CODESIGN_AGENT_BRIDGE_SECRET
const bridgeSecretConfigured =
  typeof bridgeSecret === "string" && bridgeSecret.length >= 16
const bridgeDisabled = !isLoopback && !bridgeSecretConfigured
const bridgeDisabledReason = bridgeDisabled
  ? "Bridge requires CODESIGN_AGENT_BRIDGE_SECRET (>= 16 chars) when COLLAB_WS_HOST is non-loopback"
  : undefined

if (bridgeDisabled) {
  console.warn("[agent-bridge] DISABLED:", bridgeDisabledReason)
} else if (bridgeSecretConfigured) {
  console.info("[agent-bridge] enabled with bearer auth")
} else {
  console.info(
    "[agent-bridge] enabled (loopback-only, no secret required)",
  )
}

const bridgeAllowedOrigins = (
  process.env.CODESIGN_AGENT_BRIDGE_ORIGINS ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const bridgeIdempotencyMode: "memory" | "off" =
  process.env.CODESIGN_AGENT_BRIDGE_IDEMPOTENCY_MODE === "off"
    ? "off"
    : "memory"

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[collab-server] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.\n" +
      "Copy .env.example → .env.local and fill them in."
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ---- Project metadata helpers ------------------------------------------------

type ProjectRow = {
  id: string
  name: string
  created_at: string
}

type ProjectMeta = {
  id: string
  name: string
  createdAt: string
}

const toMeta = (row: ProjectRow): ProjectMeta => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
})

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project"

/**
 * Generate a project id that doesn't collide with an existing row. Race-y,
 * but good enough for hackathon traffic — the unique constraint on the
 * primary key is the real safety net.
 */
const newProjectId = async (name: string): Promise<string> => {
  const base = slugify(name)
  let candidate = base
  let i = 1
  while (true) {
    const { data, error } = await supabase
      .from("projects")
      .select("id")
      .eq("id", candidate)
      .maybeSingle()
    if (error) throw error
    if (!data) return candidate
    i += 1
    candidate = `${base}-${i}`
  }
}

const listProjects = async (): Promise<ProjectMeta[]> => {
  const { data, error } = await supabase
    .from("projects")
    .select("id,name,created_at")
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) throw error
  return (data ?? []).map(toMeta)
}

const getProject = async (id: string): Promise<ProjectMeta | null> => {
  const { data, error } = await supabase
    .from("projects")
    .select("id,name,created_at")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return data ? toMeta(data) : null
}

const insertProject = async (name: string): Promise<ProjectMeta> => {
  const id = await newProjectId(name)
  const { data, error } = await supabase
    .from("projects")
    .insert({ id, name })
    .select("id,name,created_at")
    .single()
  if (error) throw error
  return toMeta(data)
}

// ---- Hocuspocus --------------------------------------------------------------

const hocuspocus = new Hocuspocus({
  name: "codesign",
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        console.log(`[collab-server] fetch document: "${documentName}"`)
        const { data, error } = await supabase
          .from("project_documents")
          .select("state_b64")
          .eq("project_id", documentName)
          .maybeSingle()
        if (error) {
          console.error(`[collab-server] fetch ${documentName} failed:`, error)
          return null
        }
        if (!data?.state_b64) {
          console.log(`[collab-server] fetch ${documentName}: no prior state`)
          return null
        }
        const bytes = new Uint8Array(Buffer.from(data.state_b64, "base64"))
        console.log(
          `[collab-server] fetch ${documentName}: ${bytes.length} bytes`,
        )
        return bytes
      },
      store: async ({ documentName, state }) => {
        console.log(
          `[collab-server] store ${documentName}: ${state.length} bytes`,
        )
        // The project row may not exist yet if a client raced ahead of the
        // POST /api/projects round trip. Ensure it exists so the FK holds.
        await supabase
          .from("projects")
          .upsert(
            { id: documentName, name: documentName },
            { onConflict: "id", ignoreDuplicates: true }
          )
        const { error } = await supabase.from("project_documents").upsert({
          project_id: documentName,
          state_b64: Buffer.from(state).toString("base64"),
          updated_at: new Date().toISOString(),
        })
        if (error) {
          console.error(`[collab-server] store ${documentName} failed:`, error)
        }
      },
    }),
    {
      // Inline extension just for connection logging.
      onConnect: async ({ documentName }) => {
        console.log(`[collab-server] onConnect: "${documentName}"`)
      },
      onDisconnect: async ({ documentName }) => {
        console.log(`[collab-server] onDisconnect: "${documentName}"`)
      },
      onLoadDocument: async ({ documentName }) => {
        console.log(`[collab-server] onLoadDocument: "${documentName}"`)
        return undefined
      },
    },
  ],
})

// ---- HTTP --------------------------------------------------------------------

const jsonResponse = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

const readJson = (req: IncomingMessage): Promise<{ name?: string }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk as Buffer))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (raw.length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
  })

const httpServer = createServer(async (req, res) => {
  // Agent-bridge owns `/api/agent/*`. It writes its own CORS headers and full
  // response, so we dispatch to it BEFORE setting our permissive CORS or
  // touching the response in any way. tryHandle returns false for non-bridge
  // URLs and we fall through to the existing routes.
  try {
    if (await bridge.tryHandle(req, res)) return
  } catch (err) {
    console.error(`[collab-server] agent-bridge tryHandle failed:`, err)
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "internal_error" }))
    }
    return
  }

  // Permissive CORS — the Vercel-hosted frontend talks to us cross-origin.
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`
  )
  const pathname = url.pathname

  try {
    if (pathname === "/" || pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("collab-server ok\n")
      return
    }

    if (pathname === "/api/projects" && req.method === "GET") {
      const projects = await listProjects()
      return jsonResponse(res, 200, { projects })
    }

    if (pathname === "/api/projects" && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}) as { name?: string })
      const name =
        typeof body?.name === "string" && body.name.trim().length > 0
          ? body.name.trim().slice(0, 80)
          : "Untitled project"
      const project = await insertProject(name)
      console.log(`[collab-server] project created: "${project.id}" (${name})`)
      return jsonResponse(res, 201, { project })
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (projectMatch && req.method === "GET") {
      const id = decodeURIComponent(projectMatch[1] ?? "")
      const project = await getProject(id)
      if (!project) return jsonResponse(res, 404, { error: "not_found" })
      return jsonResponse(res, 200, { project })
    }

    jsonResponse(res, 404, { error: "not_found" })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[collab-server] http error ${pathname}:`, err)
    // Surface the message in dev so the Next side shows something useful
    // instead of a generic 500. Safe enough for a hackathon backend; tighten
    // before exposing publicly.
    jsonResponse(res, 500, { error: "internal_error", message })
  }
})

// ---- WebSocket upgrade → Hocuspocus -----------------------------------------

const wss = new WebSocketServer({ noServer: true })

httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Hocuspocus types `request` as a Fetch Request, but at runtime it only
    // touches `.url` and `.headers`, both of which Node's IncomingMessage
    // already provides. Cast for TS, the duck typing works.
    const clientConnection = hocuspocus.handleConnection(
      ws,
      req as unknown as Request,
    )
    ws.binaryType = "arraybuffer"
    ws.on("message", (data: ArrayBuffer | Buffer | Buffer[]) => {
      let bytes: Uint8Array
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
      else if (Array.isArray(data)) bytes = new Uint8Array(Buffer.concat(data))
      else bytes = new Uint8Array(data)
      clientConnection.handleMessage(bytes)
    })
    ws.on("close", (code, reason) => {
      clientConnection.handleClose({
        code,
        reason: reason?.toString() ?? "",
      } as never)
    })
    ws.on("error", (err) => {
      console.warn(`[collab-server] ws error:`, err.message)
    })
  })
})


// ---- Agent bridge mount ------------------------------------------------------
// Mounted AFTER httpServer + Hocuspocus exist (so the bridge can reuse them)
// but BEFORE httpServer.listen, so the dispatcher closure used inside the
// request handler above is initialised before any traffic can hit it.

const bridge = mountAgentBridge({
  httpServer,
  hp: hocuspocus,
  supabase,
  context: {
    disabled: bridgeDisabled,
    disabledReason: bridgeDisabledReason,
    secret: bridgeSecret,
    allowedOrigins: bridgeAllowedOrigins,
    idempotencyMode: bridgeIdempotencyMode,
  },
  getProject,
})

httpServer.listen(PORT, HOST, () => {
  console.log(`[collab-server] listening on ws://${HOST}:${PORT}`)
  console.log(`[collab-server] http on    http://${HOST}:${PORT}`)
})

const shutdown = async (signal: string) => {
  console.log(`[collab-server] ${signal} received, flushing pending stores…`)
  try {
    hocuspocus.flushPendingStores()
  } catch (err) {
    console.error(`[collab-server] flush failed:`, err)
  }
  try {
    await bridge.close()
  } catch (err) {
    console.error(`[collab-server] bridge.close failed:`, err)
  }
  try {
    await closeAllCachedConnections()
  } catch (err) {
    console.error(`[collab-server] closeAllCachedConnections failed:`, err)
  }
  httpServer.close(() => process.exit(0))
  // hard cap so we don't hang forever on stuck sockets
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
