"use server"

import { withAuth } from "@workos-inc/authkit-nextjs"
import { WorkOS } from "@workos-inc/node"

/**
 * Lightweight user shape returned to the canvas client. We never ship raw
 * WorkOS user records — only the fields the assignee picker actually needs.
 */
export type WorkOsUserOption = {
  id: string
  name: string
  email: string
}

let cachedClient: WorkOS | null = null
function getClient(): WorkOS {
  if (cachedClient) return cachedClient
  const apiKey = process.env.WORKOS_API_KEY
  if (!apiKey) {
    throw new Error("WORKOS_API_KEY is not set")
  }
  cachedClient = new WorkOS(apiKey)
  return cachedClient
}

/** Build a display name from `firstName` / `lastName` / email fallback. */
function displayName(u: {
  firstName?: string | null
  lastName?: string | null
  email: string
}): string {
  const composed = [u.firstName, u.lastName].filter(Boolean).join(" ").trim()
  return composed.length > 0 ? composed : u.email
}

/**
 * List all human collaborators that can be assigned a task. Uses the
 * WorkOS Directory of users associated with this AuthKit project.
 *
 * Auth: gated on `withAuth({ ensureSignedIn: true })` so unauthenticated
 * callers can't enumerate users. Returns an empty array on misconfiguration
 * rather than throwing — the inspector falls back gracefully to a "no
 * users available" state.
 *
 * The first call may walk multiple pages of users; subsequent calls within
 * the same Node process are not cached server-side (Next.js will memoise
 * for the duration of a single request, but a re-render hits the API
 * again). The client wraps this in a single Promise via React state so a
 * given session only fetches once.
 */
export async function listAssignableUsers(): Promise<WorkOsUserOption[]> {
  await withAuth({ ensureSignedIn: true })

  let workos: WorkOS
  try {
    workos = getClient()
  } catch (err) {
    console.warn("[workos-users] client init failed:", err)
    return []
  }

  try {
    const out: WorkOsUserOption[] = []
    // The SDK exposes an async iterator via `autoPagination()` on listUsers.
    // We cap defensively at 500 users — a hackathon team shouldn't exceed
    // that, and an unbounded loop here would block a render path.
    const HARD_CAP = 500
    let cursor: string | undefined = undefined
    while (out.length < HARD_CAP) {
      const page = await workos.userManagement.listUsers({
        limit: 100,
        ...(cursor ? { after: cursor } : {}),
      })
      for (const u of page.data) {
        out.push({
          id: u.id,
          name: displayName(u),
          email: u.email,
        })
        if (out.length >= HARD_CAP) break
      }
      const nextCursor = page.listMetadata?.after
      if (!nextCursor) break
      cursor = nextCursor
    }

    // Stable alphabetical sort so the picker doesn't reshuffle between renders.
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  } catch (err) {
    console.warn("[workos-users] listUsers failed:", err)
    return []
  }
}
