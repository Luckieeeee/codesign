"use client"

import { Bot } from "lucide-react"

import type { CollaboratorPresence, PresenceMe } from "@/lib/collab"
import { cn } from "@/lib/utils"

type Size = "sm" | "md"

const SIZE_CLASSES: Record<Size, { bubble: string; text: string; badge: string; badgeIcon: string }> = {
  md: {
    bubble: "size-6",
    text: "text-[10px]",
    badge: "size-3",
    badgeIcon: "size-2",
  },
  sm: {
    bubble: "size-5",
    text: "text-[9px]",
    badge: "size-2.5",
    badgeIcon: "size-1.5",
  },
}

type Entry = {
  id: number
  name: string
  color: string
  kind: "human" | "agent"
  isMe?: boolean
}

type PresenceStackProps = {
  me?: PresenceMe
  others: CollaboratorPresence[]
  size?: Size
  maxVisible?: number
  className?: string
}

export function PresenceStack({
  me,
  others,
  size = "md",
  maxVisible = 5,
  className,
}: PresenceStackProps) {
  const sizes = SIZE_CLASSES[size]

  const all: Entry[] = [
    ...(me
      ? [{ id: -1, name: me.name, color: me.color, kind: me.kind, isMe: true }]
      : []),
    ...others.map((o) => ({
      id: o.id,
      name: o.name,
      color: o.color,
      kind: o.kind,
    })),
  ]

  const visible = all.slice(0, maxVisible)
  const overflow = all.length - visible.length

  if (all.length === 0) return null

  return (
    <div className={cn("flex -space-x-2", className)}>
      {visible.map((entry) => (
        <div
          key={entry.id}
          title={`${entry.name}${entry.isMe ? " (you)" : ""}${
            entry.kind === "agent" ? " · agent" : ""
          }`}
          className={cn(
            "relative flex items-center justify-center rounded-full border-2 border-background font-semibold text-white",
            sizes.bubble,
            sizes.text
          )}
          style={{ backgroundColor: entry.color }}
        >
          {entry.name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}

          {entry.kind === "agent" && (
            <span
              aria-hidden
              className={cn(
                "absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border border-background bg-foreground text-background",
                sizes.badge
              )}
            >
              <Bot className={sizes.badgeIcon} />
            </span>
          )}
        </div>
      ))}
      {overflow > 0 && (
        <div
          className={cn(
            "flex items-center justify-center rounded-full border-2 border-background bg-muted font-semibold",
            sizes.bubble,
            sizes.text
          )}
        >
          +{overflow}
        </div>
      )}
    </div>
  )
}
