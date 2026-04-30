"use client"

import dynamic from "next/dynamic"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { signOutAction } from "@/app/actions/auth"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { createProject, type Project } from "@/lib/projects"

const ProjectPreviewTile = dynamic(
  () =>
    import("@/components/project-preview-tile").then(
      (mod) => mod.ProjectPreviewTile
    ),
  {
    ssr: false,
    loading: () => (
      <div className="aspect-video animate-pulse rounded-xl border border-border bg-muted/40" />
    ),
  }
)

type Props = {
  initialProjects: Project[]
  loadError: string | null
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
  }
}

export function ProjectsClient({ initialProjects, loadError, user }: Props) {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [name, setName] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [isSigningOut, startSignOut] = useTransition()

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
  const tileUserName = displayName

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || isCreating) return
    setIsCreating(true)
    setCreateError(null)
    try {
      const project = await createProject(trimmed)
      setProjects((prev) => [project, ...prev])
      setName("")
      router.push(`/projects/${project.id}`)
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create project"
      )
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <main className="min-h-svh bg-background">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link href="/projects" className="font-heading text-lg font-semibold">
          Codesign
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{displayName}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={isSigningOut}
            onClick={() => startSignOut(() => signOutAction())}
          >
            {isSigningOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Projects
          </h1>
          <p className="text-sm text-muted-foreground">
            Each project is a collaborative React Flow canvas. Anyone signed in
            can join any project.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>New project</CardTitle>
            <CardDescription>
              Give it a name — you&apos;ll be redirected to the canvas.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={handleCreate}
              className="flex flex-col gap-3 sm:flex-row"
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Marketing site flow"
                disabled={isCreating}
                aria-label="Project name"
                className="sm:flex-1"
              />
              <Button
                type="submit"
                disabled={isCreating || name.trim().length === 0}
              >
                {isCreating ? "Creating…" : "Create project"}
              </Button>
            </form>
            {createError && (
              <p className="mt-3 text-sm text-destructive">{createError}</p>
            )}
          </CardContent>
        </Card>

        {loadError && (
          <Card>
            <CardHeader>
              <CardTitle>Couldn&apos;t reach the collab server</CardTitle>
              <CardDescription>
                {loadError}. Make sure the websocket server is running (
                <code className="rounded bg-muted px-1 py-0.5">
                  bun run dev:ws
                </code>
                ) and that{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  NEXT_PUBLIC_COLLAB_HTTP_URL
                </code>{" "}
                points at it.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
            All projects
          </h2>
          {projects.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No projects yet. Create one above to get started.
              </CardContent>
            </Card>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <li key={project.id}>
                  <ProjectPreviewTile
                    project={project}
                    user={{ id: user.id, name: tileUserName }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  )
}
