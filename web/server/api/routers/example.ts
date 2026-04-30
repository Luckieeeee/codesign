import { z } from "zod"

import { createTRPCRouter, publicProcedure } from "@/server/api/trpc"

export const exampleRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ name: z.string().optional() }))
    .query(({ input }) => {
      return {
        greeting: `Hello ${input.name ?? "world"}`,
        timestamp: new Date(),
      }
    }),
})
