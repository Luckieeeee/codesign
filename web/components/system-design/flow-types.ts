import type { Node } from "@xyflow/react"

import { SystemGroupNode } from "./group-node"
import { SystemIconNode } from "./icon-node"
import { SystemEdge } from "./labeled-edge"
import { SystemTextNode } from "./text-node"
import {
  SYSTEM_EDGE_TYPE,
  SYSTEM_GROUP_TYPE,
  SYSTEM_NODE_TYPE,
  SYSTEM_TEXT_TYPE,
} from "./types"

export const NODE_TYPES = {
  [SYSTEM_NODE_TYPE]: SystemIconNode,
  [SYSTEM_GROUP_TYPE]: SystemGroupNode,
  [SYSTEM_TEXT_TYPE]: SystemTextNode,
} as const

export const EDGE_TYPES = {
  [SYSTEM_EDGE_TYPE]: SystemEdge,
} as const

export function sortByGroupParenting(list: Node[]): Node[] {
  const groups: Node[] = []
  const others: Node[] = []
  for (const n of list) {
    if (n.type === SYSTEM_GROUP_TYPE) groups.push(n)
    else others.push(n)
  }
  return [...groups, ...others]
}
