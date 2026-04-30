/**
 * Build the public icon manifest for the system-design canvas.
 *
 * Walks `../icons` (the workspace-level icon library) and:
 *   1. Copies every `.svg` into `web/public/icons/<same/relative/path>`
 *      so Next.js can serve them statically.
 *   2. Writes `web/public/icons-manifest.json` with one entry per icon
 *      (id, display name, web path, category, optional subcategory).
 *
 * Run with:   bun run icons
 *
 * Both the copied tree and the manifest are git-ignored — the source of
 * truth lives in `/icons` at the repo root.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"

const HERE = new URL(".", import.meta.url).pathname
const SRC = join(HERE, "..", "..", "icons")
const PUBLIC_DIR = join(HERE, "..", "public")
const DST = join(PUBLIC_DIR, "icons")
const MANIFEST = join(PUBLIC_DIR, "icons-manifest.json")

type IconEntry = {
  id: string
  name: string
  path: string
  category: string
  subcategory?: string
}

type Manifest = {
  generatedAt: string
  count: number
  categories: { id: string; label: string; count: number }[]
  byCategory: Record<string, IconEntry[]>
}

const CATEGORY_LABELS: Record<string, string> = {
  generic: "Generic",
  aws: "AWS",
  gcp: "Google Cloud",
  azure: "Azure",
  kubernetes: "Kubernetes",
  "open-libs": "Open Libraries",
  "tech-logos": "Tech Logos",
  "brand-logos": "Brand Logos",
  "brand-logos-extra": "Brand Logos (Extra)",
}

// Default order in the sidebar — most useful for system design first.
const CATEGORY_ORDER = [
  "generic",
  "brand-logos",
  "tech-logos",
  "aws",
  "gcp",
  "azure",
  "kubernetes",
  "open-libs",
  "brand-logos-extra",
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (entry.endsWith(".svg")) out.push(p)
  }
  return out
}

function humanize(filename: string): string {
  return filename
    .replace(/\.svg$/i, "")
    .replace(/^(?:aws|gcp|azure|k8s)-/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
}

function ensureCleanDst() {
  if (existsSync(DST) || safeLstat(DST)) {
    rmSync(DST, { recursive: true, force: true })
  }
  mkdirSync(DST, { recursive: true })
}

function safeLstat(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`[build-icon-manifest] icons folder not found at ${SRC}`)
    process.exit(1)
  }

  ensureCleanDst()

  const files = walk(SRC).sort()
  const entries: IconEntry[] = []

  for (const f of files) {
    const rel = relative(SRC, f)
    const parts = rel.split("/")
    const filename = parts[parts.length - 1]
    if (!filename) continue

    const category = parts[0] ?? "misc"
    const subcategory = parts.length > 2 ? parts[1] : undefined
    const id = rel.replace(/\.svg$/i, "").replace(/[\\/]/g, ":")

    // Copy file into public/icons mirroring the source tree.
    const dest = join(DST, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(f, dest)

    entries.push({
      id,
      name: humanize(filename),
      path: `/icons/${rel}`,
      category,
      subcategory,
    })
  }

  const byCategory: Record<string, IconEntry[]> = {}
  for (const e of entries) {
    ;(byCategory[e.category] ??= []).push(e)
  }

  // Sort entries inside each category for predictable UI ordering.
  for (const list of Object.values(byCategory)) {
    list.sort((a, b) => {
      const sa = a.subcategory ?? ""
      const sb = b.subcategory ?? ""
      if (sa !== sb) return sa.localeCompare(sb)
      return a.name.localeCompare(b.name)
    })
  }

  const knownCategories = new Set(CATEGORY_ORDER)
  const extraCategories = Object.keys(byCategory)
    .filter((c) => !knownCategories.has(c))
    .sort()
  const orderedCategoryIds = [
    ...CATEGORY_ORDER.filter((c) => byCategory[c]),
    ...extraCategories,
  ]

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    count: entries.length,
    categories: orderedCategoryIds.map((id) => ({
      id,
      label: CATEGORY_LABELS[id] ?? humanize(id),
      count: byCategory[id]?.length ?? 0,
    })),
    byCategory,
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))

  console.log(
    `[build-icon-manifest] wrote ${entries.length} icons across ${orderedCategoryIds.length} categories`
  )
  console.log(`  → ${DST}`)
  console.log(`  → ${MANIFEST}`)
}

main()
