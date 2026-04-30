import "server-only"

import { headers } from "next/headers"
import { cache } from "react"

import { createCaller } from "@/server/api/root"
import { createTRPCContext } from "@/server/api/trpc"

/**
 * Wrapping the context creation in `cache` so it's reused within a single
 * request (React dedupes calls during a render pass).
 */
const getContext = cache(async () => {
  const heads = new Headers(await headers())
  heads.set("x-trpc-source", "rsc")

  return createTRPCContext({ headers: heads })
})

/**
 * Server-side tRPC caller for use inside React Server Components.
 *
 * @example
 *   const trpc = await api()
 *   const data = await trpc.example.hello({ name: "world" })
 */
export const api = cache(async () => createCaller(await getContext()))
