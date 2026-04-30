"use client"

import { BotIcon, CheckIcon, CopyIcon } from "lucide-react"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

import type { CollabUser } from "@/components/collab-flow"

type SpawnAgentDialogProps = {
  /** Project slug used in the bridge URL. */
  projectId: string
  /** Currently signed-in user — becomes the agent owner. */
  user: CollabUser
  /**
   * Optional override for the bridge base URL. When omitted, uses
   * `NEXT_PUBLIC_COLLAB_HTTP_URL` (build-time inline) or falls back to
   * the page origin / a dev default.
   */
  baseUrl?: string
}

function deriveBaseUrl(override: string | undefined): string {
  if (override && override.trim().length > 0) return override.trim()
  // `NEXT_PUBLIC_COLLAB_HTTP_URL` is inlined at build time. Fallback to
  // the dev default when running on localhost.
  const fromEnv = process.env.NEXT_PUBLIC_COLLAB_HTTP_URL
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
  if (typeof window !== "undefined") {
    // If the user is on a deployed instance and didn't configure an HTTP
    // URL, best-effort guess: same host as the WS URL but http(s).
    const wsUrl = process.env.NEXT_PUBLIC_COLLAB_WS_URL
    if (wsUrl) {
      try {
        const u = new URL(wsUrl)
        u.protocol = u.protocol === "wss:" ? "https:" : "http:"
        return `${u.protocol}//${u.host}`
      } catch {
        /* fall through */
      }
    }
  }
  return "http://127.0.0.1:1234"
}

/**
 * Build the personalised prompt text the user copies into their agent
 * harness. Pre-fills the owner headers (`X-Agent-Owner-*`) with the
 * signed-in user's WorkOS identity so collaborators see "X's agent" the
 * moment that agent starts working on the canvas.
 *
 * The agent slug defaults to a short, recognisable token derived from
 * the user's name; users can override it in the dialog before copying.
 */
function buildPromptText({
  baseUrl,
  projectId,
  user,
  agentId,
}: {
  baseUrl: string
  projectId: string
  user: CollabUser
  agentId: string
}): string {
  return `You are working on the codesign collaborative canvas as a remote
HTTP-bridge agent. Reference: \`web/AGENT_PROMPT.md\` in the codesign
repo for the full protocol spec.

# Connection details

- Base URL: \`${baseUrl}\`
- Project id: \`${projectId}\`
- Protocol: codesign-agent-bridge/1

# Required headers (send on EVERY request)

\`\`\`
X-Agent-Id: ${agentId}
X-Agent-Name: ${user.name}'s agent
X-Agent-Owner-Id: ${user.id}
X-Agent-Owner-Name: ${user.name}
X-Agent-Owner-Email: ${user.email}
\`\`\`

These owner headers are how codesign attributes your work back to
${user.name}. They appear in the live collaborator list as
"${user.name}'s agent" and on every node/edge you create or edit via
the namespaced \`data.__codesign\` provenance stamp.

# Quick smoke test

\`\`\`bash
curl -sS "${baseUrl}/api/agent/projects/${projectId}/summary" \\
  -H "X-Agent-Id: ${agentId}" \\
  -H "X-Agent-Owner-Id: ${user.id}" \\
  -H "X-Agent-Owner-Name: ${user.name}" \\
  -H "X-Agent-Owner-Email: ${user.email}"
\`\`\`

If this returns a JSON snapshot, you're connected. Use the \`revision\`
token in the response as \`baseRevision\` on subsequent
\`POST /api/agent/projects/${projectId}/edit\` calls to refuse stale
writes (see AGENT_PROMPT.md § "Optimistic concurrency").

# Recommended workflow

1. \`GET /summary\` to see the canvas + capture \`revision\`.
2. Plan the change as an \`EditOp[]\` (max 50 per call).
3. \`POST /edit\` with \`baseRevision\` + a fresh \`Idempotency-Key\`.
4. On \`409 STALE_REVISION\` the response includes the latest snapshot
   so you can replan in one round-trip.
5. Stay alive between calls if you can — the canvas shows you as
   "${user.name}'s agent" while you're active, and disappears you from
   the collaborator list ~60s after your last request.

If you need a secret it is CODESIGN_AGENT_BRIDGE_SECRET=2ead580e2104bf1738746bf2736b165e8b971387e79e8487e7b26e9ea69a1156
`
}

/**
 * Helper: derive a default agent id from the user's name.
 * `"Alice Smith"` → `"alice-smith-agent"`. Slugifies to ASCII only.
 */
function defaultAgentId(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
  return base.length > 0 ? `${base}-agent` : "agent"
}

/**
 * Top-right canvas action that opens a personalised "spawn an agent"
 * prompt — clicking copies a markdown blob the user can paste into
 * Codex, Claude Code, or any other harness. The blob includes their
 * WorkOS identity as the agent's owner headers so other collaborators
 * see "${user.name}'s agent" the moment that agent makes its first
 * request.
 */
export function SpawnAgentDialog({
  projectId,
  user,
  baseUrl,
}: SpawnAgentDialogProps) {
  const [agentId, setAgentId] = useState(() => defaultAgentId(user.name))
  const [copied, setCopied] = useState(false)

  const resolvedBaseUrl = useMemo(() => deriveBaseUrl(baseUrl), [baseUrl])
  const prompt = useMemo(
    () =>
      buildPromptText({
        baseUrl: resolvedBaseUrl,
        projectId,
        user,
        agentId: agentId.trim() || defaultAgentId(user.name),
      }),
    [resolvedBaseUrl, projectId, user, agentId]
  )

  const handleCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard requires secure context + user gesture; user can copy
         manually from the textarea */
    }
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="xs" variant="ghost">
            <BotIcon className="size-3.5" />
            Spawn agent
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BotIcon className="size-4" />
            Spawn an agent on this canvas
          </DialogTitle>
          <DialogDescription>
            Paste the snippet below into Claude Code, Codex, or any other
            agent harness. The owner headers attribute every change back to
            you — collaborators will see &ldquo;{user.name}&apos;s
            agent&rdquo; in their canvas while it&apos;s active.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              Agent id (slug)
            </span>
            <input
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              spellCheck={false}
              className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
            <span className="text-[10px] text-muted-foreground">
              Sent as <code>X-Agent-Id</code>. Pick something stable so
              repeat runs from the same harness reuse the same identity.
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              Prompt
            </span>
            <textarea
              readOnly
              value={prompt}
              rows={14}
              spellCheck={false}
              onClick={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
              className="rounded-lg border border-input bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleCopy}>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 transition-opacity",
                copied && "opacity-0"
              )}
            >
              <CopyIcon className="size-3.5" />
              Copy prompt
            </span>
            {copied && (
              <span className="absolute inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-500">
                <CheckIcon className="size-3.5" />
                Copied
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
