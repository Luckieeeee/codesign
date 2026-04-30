import { exampleRouter } from "@/server/api/routers/example"
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc"

/**
 * The root tRPC router. Add sub-routers here.
 */
export const appRouter = createTRPCRouter({
  example: exampleRouter,
})

export type AppRouter = typeof appRouter

/**
 * Server-side caller factory. Use to invoke procedures from server code
 * without an HTTP round trip.
 */
export const createCaller = createCallerFactory(appRouter)
