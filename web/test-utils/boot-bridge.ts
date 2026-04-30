/**
 * Boot a real Hocuspocus + node:http pair wired through the agent
 * bridge for in-process integration tests.
 *
 * The Database extension is a no-op (no Supabase round trip), matching
 * the pattern in `web/scripts/spike-direct-conn.ts`. A fake Supabase
 * (from `fake-supabase.ts`) provides the project-existence check via
 * the `getProject` hook passed to `mountAgentBridge`.
 *
 * Cooperative wiring: `mountAgentBridge` returns `{ tryHandle, close }`.
 * The HTTP request handler invokes `bridge.tryHandle(req, res)` first;
 * a `true` return means the bridge wrote the response and we stop.
 *
 * Per-test isolation: `_resetDocumentCacheForTesting` is called both on
 * boot and on close so the module-level warm-conn cache in
 * `flow-core/document.ts` cannot leak DirectConnections across
 * Hocuspocus instances (each test gets a fresh `Hocuspocus`).
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Database } from "@hocuspocus/extension-database"
import { Hocuspocus } from "@hocuspocus/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import { _resetDocumentCacheForTesting } from "../lib/flow-core/document"
import {
  mountAgentBridge,
  type BridgeContext,
  type MountedAgentBridge,
} from "../scripts/agent-bridge/routes"
import {
  makeFakeSupabase,
  type FakeSupabase,
  type ProjectRow,
} from "./fake-supabase"

export type BootBridgeOptions = {
  /** Bearer secret enforced by the bridge. Default: undefined (no secret). */
  secret?: string
  /** CORS allowlist. Default: undefined (server-to-server). */
  allowedOrigins?: string[]
  /** Hard-disable the bridge (gate returns 503 BRIDGE_DISABLED). */
  disabled?: boolean
  /** Reason surfaced in the 503 body when `disabled` is true. */
  disabledReason?: string
  /** Idempotency cache mode. Default: "memory". */
  idempotencyMode?: "memory" | "off"
  /** Project ids to seed in the fake Supabase. Default: ["test-project"]. */
  seedProjects?: string[]
}

export type BootedBridge = {
  /** `http://127.0.0.1:<port>` — base URL for `fetch(...)` calls. */
  url: string
  /** Underlying Hocuspocus, exposed for direct-connection seeding. */
  hp: Hocuspocus
  /** Fake Supabase, exposed so tests can mutate seeded rows on the fly. */
  supabase: FakeSupabase
  /** The mounted bridge handle; tests rarely need this directly. */
  bridge: MountedAgentBridge
  close: () => Promise<void>
}

const makeProjectRow = (id: string): ProjectRow => ({
  id,
  name: id,
  created_at: "2026-01-01T00:00:00Z",
})

export const bootBridgeForTests = async (
  opts: BootBridgeOptions = {},
): Promise<BootedBridge> => {
  // Make sure no stale DirectConnection from a prior boot's Hocuspocus
  // is still cached under a project id this test will reuse.
  _resetDocumentCacheForTesting()

  const seedIds = opts.seedProjects ?? ["test-project"]
  const seedRows: Record<string, ProjectRow> = {}
  for (const id of seedIds) seedRows[id] = makeProjectRow(id)
  const supabase = makeFakeSupabase(seedRows) as FakeSupabase

  const hp = new Hocuspocus({
    name: "test-bridge",
    extensions: [
      new Database({
        fetch: async () => null,
        store: async () => {},
      }),
    ],
  })

  const httpServer: Server = createServer(async (req, res) => {
    try {
      const handled = await bridge.tryHandle(req, res)
      if (handled) return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "internal_error", message }))
      }
      return
    }
    if (!res.headersSent) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not_found" }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    httpServer.once("error", onError)
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", onError)
      resolve()
    })
  })

  const address = httpServer.address() as AddressInfo | null
  if (!address || typeof address === "string") {
    throw new Error("[boot-bridge] failed to bind ephemeral port")
  }
  const url = `http://127.0.0.1:${address.port}`

  const context: BridgeContext = {
    disabled: opts.disabled ?? false,
    ...(opts.disabledReason !== undefined ? { disabledReason: opts.disabledReason } : {}),
    ...(opts.secret !== undefined ? { secret: opts.secret } : {}),
    ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.idempotencyMode !== undefined ? { idempotencyMode: opts.idempotencyMode } : {}),
  }

  const bridge = mountAgentBridge({
    httpServer,
    hp,
    supabase: supabase as unknown as SupabaseClient,
    context,
    getProject: async (projectId: string) => {
      const row = supabase.__tables.projects.get(projectId)
      return row ? { id: row.id } : null
    },
  })

  const close = async (): Promise<void> => {
    await bridge.close()
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()))
      httpServer.closeAllConnections?.()
    })
    hp.closeConnections()
    _resetDocumentCacheForTesting()
  }

  return { url, hp, supabase, bridge, close }
}
