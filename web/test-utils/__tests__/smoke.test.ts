import { describe, expect, test } from "bun:test"
import { makeFakeSupabase, type ProjectRow } from "../fake-supabase"

type SupabaseLike = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        maybeSingle(): Promise<{ data: ProjectRow | null; error: unknown }>
      }
    }
  }
}

describe("test-utils smoke", () => {
  test("makeFakeSupabase seeds the default test-project row", async () => {
    const supabase = makeFakeSupabase() as SupabaseLike
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .eq("id", "test-project")
      .maybeSingle()
    expect(error).toBeNull()
    expect(data?.id).toBe("test-project")
  })
})
