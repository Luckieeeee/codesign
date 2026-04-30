import { withAuth } from "@workos-inc/authkit-nextjs"
import { notFound } from "next/navigation"

import { getProject } from "@/lib/projects"
import { ProjectCanvas } from "./project-canvas"

export const dynamic = "force-dynamic"

type Params = { id: string }

export default async function ProjectPage({
  params,
}: {
  params: Promise<Params>
}) {
  const { id } = await params
  const { user } = await withAuth({ ensureSignedIn: true })
  const project = await getProject(id)
  if (!project) notFound()

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    "Anonymous"

  return (
    <ProjectCanvas
      project={project}
      user={{
        id: user.id,
        name: displayName,
        email: user.email,
      }}
    />
  )
}
