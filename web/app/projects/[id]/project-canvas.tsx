"use client"

import dynamic from "next/dynamic"

import type { Project } from "@/lib/projects"

// React Flow + Yjs touch window/WebSocket/ResizeObserver, so we can't SSR
// the canvas. Load it lazily on the client only.
const CollabFlow = dynamic(
  () => import("@/components/collab-flow").then((mod) => mod.CollabFlow),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-svh w-svw items-center justify-center text-sm text-muted-foreground">
        Loading collaborative canvas…
      </div>
    ),
  }
)

type Props = {
  project: Project
  user: { id: string; name: string; email: string }
}

export function ProjectCanvas({ project, user }: Props) {
  return <CollabFlow project={project} user={user} />
}
