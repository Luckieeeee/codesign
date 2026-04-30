/**
 * Tiny client for the collab-server's project metadata API.
 *
 * The Yjs collab server (see `scripts/collab-server.ts`) doubles as the
 * source of truth for which projects exist. The frontend hits it directly
 * over HTTP for listing/creating projects, and over WebSocket for the live
 * collaborative document.
 *
 * Configure with NEXT_PUBLIC_COLLAB_HTTP_URL (e.g. https://collab.example.com).
 */

export type Project = {
  id: string
  name: string
  createdAt: string
}

export function getCollabHttpUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_COLLAB_HTTP_URL
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/+$/, "")
  return "http://localhost:1234"
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${getCollabHttpUrl()}/api/projects`, {
    cache: "no-store",
  })
  if (!res.ok) throw new Error(await describeFailure(res, "list projects"))
  const body = (await res.json()) as { projects: Project[] }
  return body.projects ?? []
}

export async function createProject(name: string): Promise<Project> {
  const res = await fetch(`${getCollabHttpUrl()}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(await describeFailure(res, "create project"))
  const body = (await res.json()) as { project: Project }
  return body.project
}

export async function getProject(id: string): Promise<Project | null> {
  const res = await fetch(
    `${getCollabHttpUrl()}/api/projects/${encodeURIComponent(id)}`,
    { cache: "no-store" }
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await describeFailure(res, "get project"))
  const body = (await res.json()) as { project: Project }
  return body.project
}

// Pull the server's error message into the thrown Error so we don't have to
// dig through both terminals to find out what actually failed.
async function describeFailure(res: Response, action: string): Promise<string> {
  let detail: string | null = null
  try {
    const body = (await res.json()) as { message?: string; error?: string }
    detail = body.message ?? body.error ?? null
  } catch {
    // ignore — non-JSON body
  }
  return `Failed to ${action} (${res.status})${detail ? `: ${detail}` : ""}`
}
