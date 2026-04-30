import { withAuth } from "@workos-inc/authkit-nextjs"

import { ProjectsClient } from "./projects-client"
import { listProjects } from "@/lib/projects"

export const dynamic = "force-dynamic"

export default async function ProjectsPage() {
  // Middleware already enforces auth, but withAuth({ ensureSignedIn }) gives
  // us the strongly-typed user without a non-null assertion.
  const { user } = await withAuth({ ensureSignedIn: true })

  let projects: Awaited<ReturnType<typeof listProjects>> = []
  let loadError: string | null = null
  try {
    projects = await listProjects()
  } catch (err) {
    loadError =
      err instanceof Error
        ? err.message
        : "Failed to reach collaborative server"
  }

  return (
    <ProjectsClient
      initialProjects={projects}
      loadError={loadError}
      user={{
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      }}
    />
  )
}
