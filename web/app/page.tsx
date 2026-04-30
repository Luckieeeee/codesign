"use client"

import dynamic from "next/dynamic"

// React Flow + Yjs use browser-only APIs (window, WebSocket, ResizeObserver),
// so disable SSR for the collaborative canvas.
const CollabFlow = dynamic(
  () => import("@/components/collab-flow").then((mod) => mod.CollabFlow),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-svh w-svw items-center justify-center text-sm text-muted-foreground">
        Loading collaborative canvas…
      </div>
    ),
  },
)

export default function Page() {
  return <CollabFlow />
}
