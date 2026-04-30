/**
 * Shared types for the system-design canvas. The same shapes are written to
 * Yjs maps so collaborators see identical structures — keep them serialisable
 * (no functions, no class instances, no Dates).
 */

export type IconCategory =
  | "generic"
  | "aws"
  | "gcp"
  | "azure"
  | "kubernetes"
  | "open-libs"
  | "tech-logos"
  | "brand-logos"
  | "brand-logos-extra"
  | (string & {})

export type IconEntry = {
  /** Stable id like `generic:network:api-gateway`. */
  id: string
  /** Display label, e.g. "API Gateway". */
  name: string
  /** Public path, e.g. `/icons/generic/network/api-gateway.svg`. */
  path: string
  category: IconCategory
  subcategory?: string
}

export type IconManifest = {
  generatedAt: string
  count: number
  categories: { id: string; label: string; count: number }[]
  byCategory: Record<string, IconEntry[]>
}

/**
 * Data attached to every system-design node. Stored on `node.data` and synced
 * via Yjs as plain JSON.
 */
export type SystemNodeData = {
  iconId: string
  iconPath: string
  iconCategory: IconCategory
  /** What the user calls this thing in their diagram. */
  label: string
  /** Optional one-line description shown in the inspector. */
  description?: string
  /**
   * Optional grouping bucket — purely cosmetic, lets users tag nodes as
   * frontend / backend / data / etc. Free-form strings keep this open.
   */
  group?: string
  [key: string]: unknown
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "WS"
  | "GRPC"
  | "EVENT"
  | "QUERY"
  | "MUTATION"

/**
 * Data attached to every system-design edge. Edges in this app aren't just
 * arrows — they describe the contract between two services (HTTP route,
 * payload shape, notes, etc.).
 */
export type SystemEdgeData = {
  /** Short label shown on the edge (e.g. "fetchProject"). */
  label?: string
  method?: HttpMethod | string
  /** Endpoint or topic, e.g. `/api/projects/:id` or `kafka://orders.created`. */
  endpoint?: string
  /** Free-form notes — markdown-ish text. */
  notes?: string
  /** Request payload shape (raw text — JSON, TS, anything). */
  request?: string
  /** Response payload shape (raw text). */
  response?: string
  /** Internal canvas hint used to keep neighboring edge labels from stacking. */
  _labelOffset?: { x: number; y: number }
  /** Internal canvas route used to detour long edges around intermediate nodes. */
  _routePoints?: { x: number; y: number }[]
  /** Internal canvas label anchor for routed edges. */
  _routeLabel?: { x: number; y: number }
  [key: string]: unknown
}

export const SYSTEM_NODE_TYPE = "systemIcon"
export const SYSTEM_GROUP_TYPE = "systemGroup"
export const SYSTEM_TEXT_TYPE = "systemText"
export const SYSTEM_TASK_GROUP_TYPE = "systemTaskGroup"
export const SYSTEM_EDGE_TYPE = "systemEdge"

/**
 * Synthetic icon ids reserved for the "Containers" section of the sidebar.
 * Carrying these in `dataTransfer` lets the canvas drop handler decide which
 * node type to spawn without inventing a second drag MIME.
 */
export const CONTAINER_GROUP_ID = "__container__:group"
export const CONTAINER_TEXT_ID = "__container__:text"
export const CONTAINER_TASK_GROUP_ID = "__container__:task-group"

/** Default size for a freshly-dropped group. */
export const GROUP_DEFAULT_SIZE = { width: 320, height: 220 } as const

/** Default size for a freshly-dropped task group. Slightly larger than a
 * generic group — task regions tend to enclose multiple things. */
export const TASK_GROUP_DEFAULT_SIZE = { width: 420, height: 300 } as const

/**
 * Per-user toolbar toggle for how task groups are rendered. `none` hides
 * them entirely so the canvas stays clean; `mine` shows only the ones
 * assigned to the current user; `all` shows every task group.
 *
 * This setting is local UI state — it lives in `localStorage`, not in the
 * shared Yjs document, so each collaborator picks their own view.
 */
export const TASK_VISIBILITY_OPTIONS = ["all", "mine", "none"] as const
export type TaskVisibility = (typeof TASK_VISIBILITY_OPTIONS)[number]
export const DEFAULT_TASK_VISIBILITY: TaskVisibility = "all"

/**
 * Boundary colour palette. Stored as a string key on `SystemGroupData.color`
 * so it survives Yjs round-trips, agent-bridge serialisation, and theme
 * changes without baking in raw hex values that won't read on both light
 * and dark backgrounds.
 */
export const BOUNDARY_COLORS = [
  "slate",
  "red",
  "amber",
  "emerald",
  "sky",
  "violet",
  "pink",
  "stone",
] as const

export type BoundaryColor = (typeof BOUNDARY_COLORS)[number]

/**
 * Resolved Tailwind classes for each boundary colour. `fill` is the
 * low-alpha background painted across the whole boundary; `border` is the
 * idle ring; `borderSelected` is the focus ring; `chip` styles the small
 * colour-coded chips (assignee, status) the boundary surfaces.
 */
export const BOUNDARY_COLOR_STYLES: Record<
  BoundaryColor,
  { fill: string; border: string; borderSelected: string; chip: string }
> = {
  slate: {
    fill: "bg-slate-500/10",
    border: "border-slate-500/40",
    borderSelected: "border-slate-500/70",
    chip: "bg-slate-500/20 text-slate-700 dark:text-slate-200",
  },
  red: {
    fill: "bg-red-500/10",
    border: "border-red-500/40",
    borderSelected: "border-red-500/70",
    chip: "bg-red-500/20 text-red-700 dark:text-red-200",
  },
  amber: {
    fill: "bg-amber-500/10",
    border: "border-amber-500/50",
    borderSelected: "border-amber-500/70",
    chip: "bg-amber-500/25 text-amber-800 dark:text-amber-200",
  },
  emerald: {
    fill: "bg-emerald-500/10",
    border: "border-emerald-500/40",
    borderSelected: "border-emerald-500/70",
    chip: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200",
  },
  sky: {
    fill: "bg-sky-500/10",
    border: "border-sky-500/40",
    borderSelected: "border-sky-500/70",
    chip: "bg-sky-500/20 text-sky-700 dark:text-sky-200",
  },
  violet: {
    fill: "bg-violet-500/10",
    border: "border-violet-500/40",
    borderSelected: "border-violet-500/70",
    chip: "bg-violet-500/20 text-violet-700 dark:text-violet-200",
  },
  pink: {
    fill: "bg-pink-500/10",
    border: "border-pink-500/40",
    borderSelected: "border-pink-500/70",
    chip: "bg-pink-500/20 text-pink-700 dark:text-pink-200",
  },
  stone: {
    fill: "bg-stone-500/10",
    border: "border-stone-500/40",
    borderSelected: "border-stone-500/70",
    chip: "bg-stone-500/20 text-stone-700 dark:text-stone-200",
  },
}

export const DEFAULT_BOUNDARY_COLOR: BoundaryColor = "slate"

export function resolveBoundaryColor(value: unknown): BoundaryColor {
  return typeof value === "string" &&
    (BOUNDARY_COLORS as readonly string[]).includes(value)
    ? (value as BoundaryColor)
    : DEFAULT_BOUNDARY_COLOR
}

/**
 * Bolder palette used by **task groups** specifically.
 *
 * Task groups sit at the bottom of the canvas (`zIndex: -10000`) so other
 * nodes paint on top of them. The shared `BOUNDARY_COLOR_STYLES` palette
 * uses ~10% fill / ~40% border opacity, which works for the dashed generic
 * group (deliberately recessive) but reads as "barely there" on a task
 * region you're trying to identify at a glance.
 *
 * This palette roughly doubles fill saturation and pushes borders to ~70%
 * so the colour stays readable even with icons sitting on top of it.
 * Light/dark variants are tuned per-colour so amber/sky/emerald don't
 * blow out in light mode while still being visible in dark mode.
 */
export const TASK_BOUNDARY_COLOR_STYLES: Record<
  BoundaryColor,
  { fill: string; border: string; borderSelected: string; chip: string }
> = {
  slate: {
    fill: "bg-slate-500/20 dark:bg-slate-500/25",
    border: "border-slate-500/70",
    borderSelected: "border-slate-500",
    chip: "bg-slate-500/30 text-slate-800 dark:text-slate-100",
  },
  red: {
    fill: "bg-red-500/20 dark:bg-red-500/25",
    border: "border-red-500/70",
    borderSelected: "border-red-500",
    chip: "bg-red-500/30 text-red-800 dark:text-red-100",
  },
  amber: {
    fill: "bg-amber-400/30 dark:bg-amber-500/25",
    border: "border-amber-500/80",
    borderSelected: "border-amber-500",
    chip: "bg-amber-400/40 text-amber-900 dark:text-amber-100",
  },
  emerald: {
    fill: "bg-emerald-500/20 dark:bg-emerald-500/25",
    border: "border-emerald-500/70",
    borderSelected: "border-emerald-500",
    chip: "bg-emerald-500/30 text-emerald-800 dark:text-emerald-100",
  },
  sky: {
    fill: "bg-sky-500/20 dark:bg-sky-500/25",
    border: "border-sky-500/70",
    borderSelected: "border-sky-500",
    chip: "bg-sky-500/30 text-sky-800 dark:text-sky-100",
  },
  violet: {
    fill: "bg-violet-500/20 dark:bg-violet-500/25",
    border: "border-violet-500/70",
    borderSelected: "border-violet-500",
    chip: "bg-violet-500/30 text-violet-800 dark:text-violet-100",
  },
  pink: {
    fill: "bg-pink-500/20 dark:bg-pink-500/25",
    border: "border-pink-500/70",
    borderSelected: "border-pink-500",
    chip: "bg-pink-500/30 text-pink-800 dark:text-pink-100",
  },
  stone: {
    fill: "bg-stone-500/20 dark:bg-stone-500/25",
    border: "border-stone-500/70",
    borderSelected: "border-stone-500",
    chip: "bg-stone-500/30 text-stone-800 dark:text-stone-100",
  },
}

/** Who owns a task — always a human collaborator. Agents are not pickable here. */
export type TaskAssignee = {
  /**
   * WorkOS user id (e.g. `user_01H...`). Stable across renames so referenced
   * tasks keep pointing at the right person even if the display name changes.
   */
  id: string
  /** Display name at assign time — denormalised so the chip stays meaningful
   * if WorkOS is briefly unreachable when the inspector opens. */
  name: string
  /** Email at assign time — useful as a tiebreaker / fallback display. */
  email?: string
}

export const TASK_STATUSES = [
  "todo",
  "in-progress",
  "done",
  "blocked",
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * Data attached to a group / container node.
 *
 * Group nodes hold no icon — they're a labelled bounding box that other
 * nodes can be parented to (React Flow's `parentId` + `extent: "parent"`).
 *
 * The generic group is intentionally minimal — it's a visual cluster /
 * labelled boundary, **not** a task assignment. Use `SystemTaskGroupData`
 * (a separate node type) when you want to assign a region of the canvas
 * to a teammate.
 */
export type SystemGroupData = {
  label: string
  /**
   * Optional palette key from `BOUNDARY_COLORS`. Falls back to the default
   * when missing or unknown. Stored as a string key so it survives Yjs
   * round-trips and theme changes without baking in raw hex values.
   */
  color?: BoundaryColor | (string & {})
  [key: string]: unknown
}

/**
 * Data attached to a **task group** — a coloured boundary box with a human
 * assignee, task description, and status.
 *
 * Task groups are visually distinct from generic groups, render *behind*
 * every other node (so they never get in the way of icons), and are
 * filtered by the toolbar visibility toggle ("only mine" / "everyone" /
 * "none"). They are not drop targets — children are not parented to them.
 */
export type SystemTaskGroupData = {
  label: string
  /** Palette key from `BOUNDARY_COLORS`. */
  color?: BoundaryColor | (string & {})
  /** WorkOS-backed assignee. `null` / `undefined` = unassigned. */
  assignee?: TaskAssignee | null
  /** Free-form task description. */
  task?: string
  /** Workflow state. */
  status?: TaskStatus
  [key: string]: unknown
}

/** Data attached to a free-floating text annotation / sticky note. */
export type SystemTextData = {
  text: string
  /** Heading vs body — controls font size only. */
  variant?: "heading" | "body"
  [key: string]: unknown
}

export const HTTP_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "WS",
  "GRPC",
  "EVENT",
  "QUERY",
  "MUTATION",
]

/** DataTransfer key used when dragging items from the sidebar onto the canvas. */
export const ICON_DRAG_MIME = "application/x-codesign-icon"
