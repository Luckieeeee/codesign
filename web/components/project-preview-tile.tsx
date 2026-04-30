"use client"

import "@xyflow/react/dist/style.css"

import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react"
import Link from "next/link"

import { PresenceStack } from "@/components/presence-stack"
import {
  EDGE_TYPES,
  NODE_TYPES,
} from "@/components/system-design/flow-types"
import type { Project } from "@/lib/projects"
import { useCollabDoc } from "@/lib/use-collab-doc"
import { cn } from "@/lib/utils"

type Props = {
  project: Project
  user: { id: string; name: string }
  className?: string
}

export function ProjectPreviewTile({ project, user, className }: Props) {
  return (
    <ReactFlowProvider>
      <ProjectPreviewTileInner
        project={project}
        user={user}
        className={className}
      />
    </ReactFlowProvider>
  )
}

function ProjectPreviewTileInner({ project, user, className }: Props) {
  const { status, nodes, edges, collaborators } = useCollabDoc({
    projectId: project.id,
    user: { id: user.id, name: user.name, kind: "human" },
    passive: true,
  })

  const isLoading = status !== "connected" && nodes.length === 0
  const isEmpty = status === "connected" && nodes.length === 0

  return (
    <div
      className={cn(
        "group relative aspect-video overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md",
        className
      )}
    >
      <div className="pointer-events-none absolute inset-0">
        <MiniFlow nodes={nodes} edges={edges} />
      </div>

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/40">
          <span className="text-xs text-muted-foreground">Loading…</span>
        </div>
      )}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-md border border-dashed border-border bg-background/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
            Empty canvas
          </span>
        </div>
      )}

      <Link
        href={`/projects/${project.id}`}
        className="absolute inset-0 z-10"
        aria-label={`Open ${project.name}`}
      />

      <div className="pointer-events-none absolute left-2 top-2 z-20 max-w-[calc(100%-1rem)]">
        <div className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-background/85 px-2 py-1 shadow-sm backdrop-blur">
          <div
            className="truncate font-heading text-sm font-medium"
            title={project.name}
          >
            {project.name}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                status === "connected" && "bg-emerald-500",
                status === "connecting" && "animate-pulse bg-amber-500",
                status === "disconnected" && "bg-rose-500"
              )}
              aria-hidden
              title={status}
            />
            <span className="truncate">
              {new Date(project.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>

      {collaborators.length > 0 && (
        <div className="pointer-events-auto absolute bottom-2 right-2 z-20 rounded-full border border-border/60 bg-background/85 px-1.5 py-1 shadow-sm backdrop-blur">
          <PresenceStack others={collaborators} size="sm" maxVisible={4} />
        </div>
      )}
    </div>
  )
}

function MiniFlow({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnDrag={false}
      panOnScroll={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.05}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      className="bg-background"
    >
      <Background gap={24} size={1} color="var(--border)" />
    </ReactFlow>
  )
}
