import { handleAuth } from "@workos-inc/authkit-nextjs"

// WorkOS will redirect here after the user authenticates. AuthKit exchanges
// the code, sets the session cookie, and redirects to `returnPathname` (or
// `/projects` if none was provided).
export const GET = handleAuth({ returnPathname: "/projects" })
