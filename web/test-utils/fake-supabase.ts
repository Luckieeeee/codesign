/**
 * Minimal fake of `@supabase/supabase-js`'s client surface used by
 * `web/scripts/collab-server.ts` and the (forthcoming) agent bridge.
 *
 * Goals:
 *   - Zero network. Pure in-memory.
 *   - Just enough chaining to satisfy the call sites we actually use:
 *       .from("projects").select(...).eq("id", id).maybeSingle()
 *       .from("projects").select(...).order(...).limit(...)         (awaited)
 *       .from("projects").insert({...}).select(...).single()
 *       .from("projects").upsert({...}, { onConflict, ignoreDuplicates }) (awaited)
 *       .from("project_documents").select("state_b64").eq("project_id", id).maybeSingle()
 *       .from("project_documents").upsert({...}).select()           (awaited)
 *   - The query builder is a thenable so `await builder` resolves to
 *     `{ data, error }` for the supabase-style chains that don't end in
 *     `.maybeSingle()` / `.single()`.
 *
 * Return type is `unknown` on purpose — we don't try to satisfy
 * `SupabaseClient`'s real type. Tests cast at the use site.
 */

export type ProjectRow = {
  id: string
  name: string
  created_at: string
}

export type ProjectDocumentRow = {
  project_id: string
  state_b64: string
  updated_at?: string
}

type Tables = {
  projects: Map<string, ProjectRow>
  project_documents: Map<string, ProjectDocumentRow>
}

type SupabaseResult<T> = { data: T; error: null } | { data: null; error: Error }

type Filter = { col: string; val: unknown }

const DEFAULT_PROJECT: ProjectRow = {
  id: "test-project",
  name: "Test",
  created_at: "2026-01-01T00:00:00Z",
}

const matchRow = (row: Record<string, unknown>, filters: Filter[]): boolean =>
  filters.every((f) => row[f.col] === f.val)

class QueryBuilder<TRow extends Record<string, unknown>>
  implements PromiseLike<SupabaseResult<TRow[]>>
{
  private filters: Filter[] = []
  private orderBy: { col: string; ascending: boolean } | null = null
  private limitN: number | null = null
  private pendingMutation:
    | { kind: "insert"; row: TRow }
    | {
        kind: "upsert"
        row: TRow
        opts?: { onConflict?: string; ignoreDuplicates?: boolean }
      }
    | null = null

  constructor(
    private readonly table: Map<string, TRow>,
    private readonly primaryKey: keyof TRow & string,
  ) {}

  select(): this {
    return this
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ col, val })
    return this
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, ascending: opts?.ascending ?? true }
    return this
  }

  limit(n: number): this {
    this.limitN = n
    return this
  }

  insert(row: TRow): this {
    this.pendingMutation = { kind: "insert", row }
    return this
  }

  upsert(
    row: TRow,
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this.pendingMutation = { kind: "upsert", row, opts }
    return this
  }

  async maybeSingle(): Promise<SupabaseResult<TRow | null>> {
    const rows = this.runQuery()
    if (rows.length === 0) return { data: null, error: null }
    return { data: rows[0] ?? null, error: null }
  }

  async single(): Promise<SupabaseResult<TRow>> {
    const rows = this.runQuery()
    if (rows.length === 0) {
      return { data: null, error: new Error("PGRST116: no rows returned") }
    }
    return { data: rows[0] as TRow, error: null }
  }

  then<TResult1 = SupabaseResult<TRow[]>, TResult2 = never>(
    onfulfilled?:
      | ((value: SupabaseResult<TRow[]>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.runAsList()).then(onfulfilled, onrejected)
  }

  private runQuery(): TRow[] {
    this.applyMutation()
    let rows = Array.from(this.table.values()) as TRow[]
    if (this.filters.length > 0) {
      rows = rows.filter((row) =>
        matchRow(row as Record<string, unknown>, this.filters),
      )
    }
    if (this.orderBy) {
      const { col, ascending } = this.orderBy
      rows.sort((a, b) => {
        const av = (a as Record<string, unknown>)[col]
        const bv = (b as Record<string, unknown>)[col]
        if (av === bv) return 0
        const cmp = (av as never) < (bv as never) ? -1 : 1
        return ascending ? cmp : -cmp
      })
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN)
    return rows
  }

  private runAsList(): SupabaseResult<TRow[]> {
    return { data: this.runQuery(), error: null }
  }

  private applyMutation(): void {
    if (!this.pendingMutation) return
    const mutation = this.pendingMutation
    const key = String(mutation.row[this.primaryKey])
    const exists = this.table.has(key)
    if (mutation.kind === "insert") {
      this.table.set(key, this.fillDefaults(mutation.row))
    } else {
      if (exists && mutation.opts?.ignoreDuplicates) {
        // no-op
      } else {
        const merged = exists
          ? { ...(this.table.get(key) as TRow), ...mutation.row }
          : this.fillDefaults(mutation.row)
        this.table.set(key, merged)
      }
    }
    this.pendingMutation = null
  }

  private fillDefaults(row: TRow): TRow {
    if (this.primaryKey === "id" && !("created_at" in row)) {
      return {
        ...row,
        created_at: new Date().toISOString(),
      } as TRow
    }
    return row
  }
}

export type FakeSupabase = {
  from(table: string): QueryBuilder<Record<string, unknown>>
  /** Test-only: read the underlying tables. */
  __tables: Tables
}

/**
 * Build a fake supabase client. By default seeds a single project row at
 * `id = "test-project"` so route-level integration tests can hit
 * `/projects/test-project/...` without arranging fixtures.
 */
export const makeFakeSupabase = (
  rows?: Record<string, ProjectRow>,
): unknown => {
  const tables: Tables = {
    projects: new Map(),
    project_documents: new Map(),
  }
  const seed = rows ?? { [DEFAULT_PROJECT.id]: DEFAULT_PROJECT }
  for (const [id, row] of Object.entries(seed)) {
    tables.projects.set(id, row)
  }

  const client: FakeSupabase = {
    from(table: string): QueryBuilder<Record<string, unknown>> {
      if (table === "projects") {
        return new QueryBuilder<ProjectRow>(
          tables.projects,
          "id",
        ) as unknown as QueryBuilder<Record<string, unknown>>
      }
      if (table === "project_documents") {
        return new QueryBuilder<ProjectDocumentRow>(
          tables.project_documents,
          "project_id",
        ) as unknown as QueryBuilder<Record<string, unknown>>
      }
      return new QueryBuilder<Record<string, unknown>>(new Map(), "id")
    },
    __tables: tables,
  }
  return client
}
