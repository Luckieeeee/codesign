import { withAuth } from "@workos-inc/authkit-nextjs"
import Link from "next/link"
import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"

// Bare landing page: a single CTA into WorkOS AuthKit. Once signed in we
// jump straight to the projects list.
export default async function LandingPage() {
  const { user } = await withAuth()
  if (user) redirect("/projects")

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Codesign
        </h1>
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/auth/sign-in?returnTo=/projects" />}
        >
          Login to Codesign
        </Button>
      </div>
    </main>
  )
}
