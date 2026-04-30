import { getSignInUrl } from "@workos-inc/authkit-nextjs"
import { redirect } from "next/navigation"

// Route handlers ARE allowed to mutate cookies (unlike server components),
// which is why we kick the sign-in flow off here instead of from the
// landing page directly. AuthKit's getSignInUrl() writes a PKCE state cookie.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const returnTo = url.searchParams.get("returnTo") ?? "/projects"
  const signInUrl = await getSignInUrl({ returnTo })
  redirect(signInUrl)
}
