"use client"

import { ChevronDownIcon, SearchIcon } from "lucide-react"
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import {
  CONTAINER_GROUP_ID,
  CONTAINER_TASK_GROUP_ID,
  CONTAINER_TEXT_ID,
  ICON_DRAG_MIME,
  type IconEntry,
  type IconManifest,
} from "./types"

type IconSidebarProps = {
  className?: string
  /**
   * Which side of the canvas the sidebar lives on. Controls border placement
   * only — the rail's outer width is owned by the parent (resizable panel).
   */
  side?: "left" | "right"
}

/**
 * Right-rail icon library.
 *
 * Loads `/icons-manifest.json` once, lets the user search across all 1.6k+
 * icons or browse by category. Each tile is a native HTML drag source — the
 * canvas (`onDrop`) reads the JSON-encoded icon entry off `dataTransfer` and
 * spawns a new node at the drop point.
 *
 * Rendering is virtualised-by-collapse: closed categories render zero tiles,
 * so even with the full manifest loaded the DOM stays small.
 */
export function IconSidebar({ className, side = "left" }: IconSidebarProps) {
  const [manifest, setManifest] = useState<IconManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)

  // Track open/closed categories. First category opens by default once the
  // manifest lands so the sidebar isn't an empty wall on first paint — done
  // as derived state below to avoid a setState-in-effect lint error.
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [didSeedOpen, setDidSeedOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch("/icons-manifest.json", { cache: "force-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        return res.json() as Promise<IconManifest>
      })
      .then((data) => {
        if (cancelled) return
        setManifest(data)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load icons")
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (manifest && !didSeedOpen) {
    setDidSeedOpen(true)
    const first = manifest.categories[0]?.id
    if (first) setOpen({ [first]: true })
  }

  // When the user types a query, force every category open so they can see
  // matches without expanding things by hand.
  const queryActive = deferredQuery.trim().length > 0

  const filtered = useMemo(() => {
    if (!manifest) return null
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return manifest.byCategory
    const out: Record<string, IconEntry[]> = {}
    for (const [cat, list] of Object.entries(manifest.byCategory)) {
      const hits = list.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q) ||
          (i.subcategory ?? "").toLowerCase().includes(q)
      )
      if (hits.length > 0) out[cat] = hits
    }
    return out
  }, [manifest, deferredQuery])

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col bg-background",
        side === "left" ? "border-r border-border" : "border-l border-border",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            Library
          </span>
          <span className="text-sm font-medium">
            Icons{" "}
            {manifest && (
              <span className="text-xs font-normal text-muted-foreground">
                · {manifest.count}
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="border-b border-border px-3 py-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 1,600+ icons…"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Containers section is always at the top — group + text node tiles
            use the same DataTransfer MIME as icons but with synthetic ids
            (CONTAINER_GROUP_ID / CONTAINER_TEXT_ID) so the canvas drop
            handler knows to spawn a different node type. */}
        {!queryActive && (
          <CategoryGroup
            title="Containers"
            count={3}
            isOpen={open["__containers__"] ?? true}
            onToggle={() =>
              setOpen((prev) => ({
                ...prev,
                __containers__: !(prev["__containers__"] ?? true),
              }))
            }
          >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1">
              <ContainerTile
                id={CONTAINER_GROUP_ID}
                name="Group"
                description="Boundary / cluster"
                preview={
                  <div className="size-7 rounded-md border-2 border-dashed border-foreground/40" />
                }
              />
              <ContainerTile
                id={CONTAINER_TASK_GROUP_ID}
                name="Task"
                description="Assigned region"
                preview={
                  <div className="size-7 rounded-md border-2 border-sky-500/50 bg-sky-500/15" />
                }
              />
              <ContainerTile
                id={CONTAINER_TEXT_ID}
                name="Note"
                description="Text annotation"
                preview={
                  <span className="font-serif text-base leading-none text-foreground/80">
                    T
                  </span>
                }
              />
            </div>
          </CategoryGroup>
        )}

        {error && (
          <p className="p-3 text-xs text-destructive">
            Couldn&apos;t load icons: {error}. Run{" "}
            <code className="rounded bg-muted px-1 py-0.5">bun run icons</code>{" "}
            to generate the manifest.
          </p>
        )}

        {!manifest && !error && (
          <p className="p-3 text-xs text-muted-foreground">Loading icons…</p>
        )}

        {manifest &&
          filtered &&
          manifest.categories.map((cat) => {
            const list = filtered[cat.id]
            if (!list || list.length === 0) return null
            const isOpen = queryActive || open[cat.id]
            return (
              <CategoryGroup
                key={cat.id}
                title={cat.label}
                count={list.length}
                isOpen={!!isOpen}
                onToggle={() =>
                  setOpen((prev) => ({ ...prev, [cat.id]: !prev[cat.id] }))
                }
              >
                <IconGrid icons={list} />
              </CategoryGroup>
            )
          })}

        {manifest && filtered && Object.keys(filtered).length === 0 && (
          <p className="p-3 text-center text-xs text-muted-foreground">
            No icons match &ldquo;{query}&rdquo;
          </p>
        )}
      </div>

      <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
        Drag any tile onto the canvas
      </div>
    </aside>
  )
}

/**
 * Tiles for the Containers section. Smaller-grid (2 cols) so they read as
 * a distinct shelf above the icon grid.
 */
function ContainerTile({
  id,
  name,
  description,
  preview,
}: {
  id: string
  name: string
  description: string
  preview: React.ReactNode
}) {
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    // Reuse IconEntry shape so the drop handler has one schema. The synthetic
    // id is the signal that this is a container, not a real icon.
    const payload: IconEntry = {
      id,
      name,
      path: "",
      category: "generic",
    }
    e.dataTransfer.setData(ICON_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.setData("text/plain", name)
    e.dataTransfer.effectAllowed = "copy"
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      title={description}
      className={cn(
        "flex aspect-[2/1] cursor-grab items-center gap-2 rounded-md border border-transparent px-2 py-1.5 transition-colors",
        "hover:border-border hover:bg-muted active:cursor-grabbing active:bg-muted"
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card">
        {preview}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[11px] font-medium">{name}</span>
        <span className="truncate text-[9px] text-muted-foreground">
          {description}
        </span>
      </div>
    </div>
  )
}

function CategoryGroup({
  title,
  count,
  isOpen,
  onToggle,
  children,
}: {
  title: string
  count: number
  isOpen: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-border/60">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "sticky top-0 z-10 flex w-full items-center justify-between gap-2 bg-background/95 px-3 py-1.5 text-[11px] font-medium tracking-wider uppercase backdrop-blur",
          "text-muted-foreground hover:text-foreground"
        )}
      >
        <span className="flex items-center gap-1.5">
          <ChevronDownIcon
            className={cn(
              "size-3 transition-transform",
              isOpen ? "rotate-0" : "-rotate-90"
            )}
          />
          {title}
        </span>
        <span className="tabular-nums opacity-60">{count}</span>
      </button>
      {isOpen && <div className="px-2 pb-2">{children}</div>}
    </section>
  )
}

function IconGrid({ icons }: { icons: IconEntry[] }) {
  // Auto-fill columns at a fixed tile width — when the panel grows we get
  // more tiles per row instead of larger tiles. Keeps the icons at a
  // legible-but-compact size regardless of sidebar width.
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1">
      {icons.map((icon) => (
        <IconTile key={icon.id} icon={icon} />
      ))}
    </div>
  )
}

function IconTile({ icon }: { icon: IconEntry }) {
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    const payload = JSON.stringify(icon)
    e.dataTransfer.setData(ICON_DRAG_MIME, payload)
    // Fallback so other drop targets (e.g. text editors) still get something
    // sane if the user accidentally drops the icon outside the canvas.
    e.dataTransfer.setData("text/plain", icon.name)
    e.dataTransfer.effectAllowed = "copy"
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      title={`${icon.name}${icon.subcategory ? ` · ${icon.subcategory}` : ""}`}
      className={cn(
        "group flex aspect-square cursor-grab flex-col items-center justify-center gap-1 rounded-md border border-transparent p-1.5 transition-colors",
        "hover:border-border hover:bg-muted active:cursor-grabbing active:bg-muted"
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={icon.path}
        alt={icon.name}
        draggable={false}
        className="pointer-events-none size-7 object-contain"
        style={{ color: "var(--foreground)" }}
        loading="lazy"
      />
      <span className="line-clamp-1 max-w-full text-center text-[9px] leading-tight text-muted-foreground group-hover:text-foreground">
        {icon.name}
      </span>
    </div>
  )
}
