import { promises as fs } from "node:fs"
import path from "node:path"

import type { AgentIconEntry } from "./types"

type ManifestShape = {
  byCategory?: Record<
    string,
    Array<{ id: string; name: string; category?: string }>
  >
}

let cache: AgentIconEntry[] | null = null

/**
 * Load and cache the public icon manifest at process start. We send a
 * curated subset to the AI model so it can pick exact iconIds — the full
 * manifest is ~1.6k entries which is too verbose for every prompt.
 *
 * Strategy:
 * - Always include `generic:*` (the portable icon set, ~240 entries).
 * - Include all cloud-provider icons (`aws:*`, `gcp:*`, `azure:*`,
 *   `kubernetes:*`) — small categories, often requested by name.
 * - Include all `tech-logos:*` (~125 entries) — common service brands.
 * - Skip `brand-logos:*` and `brand-logos-extra:*` by default (almost 900
 *   entries, mostly UI tooling). The model can still ask for one with a
 *   short hint string and we'll fuzzy-match client-side.
 */
export async function loadIconCatalog(): Promise<AgentIconEntry[]> {
  if (cache) return cache

  const manifestPath = path.join(
    process.cwd(),
    "public",
    "icons-manifest.json",
  )
  const raw = await fs.readFile(manifestPath, "utf8")
  const data = JSON.parse(raw) as ManifestShape
  const byCategory = data.byCategory ?? {}

  const include = new Set([
    "generic",
    "aws",
    "gcp",
    "azure",
    "kubernetes",
    "tech-logos",
  ])

  const out: AgentIconEntry[] = []
  for (const [cat, list] of Object.entries(byCategory)) {
    if (!include.has(cat)) continue
    for (const entry of list) {
      if (!entry?.id || !entry?.name) continue
      out.push({ id: entry.id, name: entry.name })
    }
  }

  cache = out
  return out
}
