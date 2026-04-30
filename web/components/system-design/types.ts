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
  [key: string]: unknown
}

export const SYSTEM_NODE_TYPE = "systemIcon"
export const SYSTEM_GROUP_TYPE = "systemGroup"
export const SYSTEM_TEXT_TYPE = "systemText"
export const SYSTEM_EDGE_TYPE = "systemEdge"

/**
 * Synthetic icon ids reserved for the "Containers" section of the sidebar.
 * Carrying these in `dataTransfer` lets the canvas drop handler decide which
 * node type to spawn without inventing a second drag MIME.
 */
export const CONTAINER_GROUP_ID = "__container__:group"
export const CONTAINER_TEXT_ID = "__container__:text"

/** Default size for a freshly-dropped group. */
export const GROUP_DEFAULT_SIZE = { width: 320, height: 220 } as const

/**
 * Data attached to a group / container node.
 *
 * Group nodes hold no icon — they're a labelled bounding box that other
 * nodes can be parented to (React Flow's `parentId` + `extent: "parent"`).
 */
export type SystemGroupData = {
  label: string
  /** Optional accent colour swatch (hex). Just visual — no behavioural tie. */
  color?: string
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
