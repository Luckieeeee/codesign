import { authkitProxy } from "@workos-inc/authkit-nextjs"

// Next.js 16 renamed `middleware` to `proxy`. AuthKit's `authkitProxy`
// reads WORKOS_CLIENT_ID / WORKOS_API_KEY / WORKOS_COOKIE_PASSWORD /
// NEXT_PUBLIC_WORKOS_REDIRECT_URI from the environment.
//
// Every route is protected by default; only the marketing landing at "/"
// is reachable when signed out.
export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/"],
  },
})

export const config = {
  matcher: [
    "/((?!_next/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
