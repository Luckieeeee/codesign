import { initTRPC } from "@trpc/server"
import superjson from "superjson"
import { ZodError } from "zod"

/**
 * Context passed to every tRPC procedure. Extend this with auth, db, etc.
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
  return {
    headers: opts.headers,
  }
}

export type Context = Awaited<ReturnType<typeof createTRPCContext>>

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    }
  },
})

export const createTRPCRouter = t.router
export const createCallerFactory = t.createCallerFactory
export const publicProcedure = t.procedure
