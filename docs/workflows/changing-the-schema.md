# Changing the schema

The schema is in [src/db/schema.ts](../../src/db/schema.ts) (Drizzle).
Migrations are **generated** from that file by `drizzle-kit generate`
and written to [src/db/migrations/](../../src/db/migrations/).

## Inventory

| concern | file |
|---------|------|
| Drizzle schema | [src/db/schema.ts](../../src/db/schema.ts) |
| Generated SQL | [src/db/migrations/](../../src/db/migrations/) |
| Drizzle config | [drizzle.config.ts](../../drizzle.config.ts) |
| Migration runner | [src/db/index.ts:79–113 `migrate()`](../../src/db/index.ts) |
| Queries | [src/db/queries.ts](../../src/db/queries.ts) |
| Schema reference doc | [docs/schema.md](../schema.md) |

## Step 1 — Edit the Drizzle schema

Add the column / table / index in
[src/db/schema.ts](../../src/db/schema.ts):

```ts
export const widget = sqliteTable(
  'widget',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
);
```

If you're adding to the `Schema` type, update the export at the bottom
of the file too.

## Step 2 — Generate the migration

```
npx drizzle-kit generate
```

This writes `src/db/migrations/<NNNN>_<auto-name>.sql`. **Read it** —
make sure the SQL is what you expected. Drizzle is clever, but for
SQLite some changes (column type changes, dropping NOT NULL on an
existing column) require a table-rebuild and Drizzle generates the
right thing only if you understand its mode.

For ALTER-heavy changes that Drizzle doesn't generate cleanly,
**rename the auto-generated file** to match the convention
(`^\d+_.+\.sql$`) and edit the SQL by hand. The runner doesn't care how
the file was produced — only that the version number is monotonic and
the file is idempotent within a transaction.

## Step 3 — Review the migration

Open the new SQL file. Confirm:

- Statement separators (`--> statement-breakpoint`) are present where
  Drizzle expects them.
- `CREATE INDEX` statements use the partial-index `WHERE` clause where
  they should (look at how `idx_qa_pending` is generated as a reference).
- Foreign keys have the correct `ON DELETE` action (`cascade` for
  child-of-parent relationships, `restrict` for the audit chain).
- `CHECK` constraints are present for enum-style columns.

## Step 4 — Run migrations against a fresh DB

The migration runner is custom and tiny
([src/db/index.ts](../../src/db/index.ts)). Test it:

```bash
rm -rf /tmp/dedupe-test/.dedupe
TARGET_ROOT=/tmp/dedupe-test npm run dev:server
# Watch the logs for "applied: [<NNNN>]"
```

Then bring up the SQLite shell:

```bash
sqlite3 /tmp/dedupe-test/.dedupe/state.db
.schema widget
SELECT * FROM schema_version;
```

The `schema_version` table should list every migration with its
`applied_at` timestamp.

## Step 5 — Add the queries

Add to [src/db/queries.ts](../../src/db/queries.ts). Prefer Drizzle:

```ts
export function listWidgets(db: Db) {
  return db.q.select().from(widget).all();
}
```

Drop into raw `db.client.prepare(...)` only when Drizzle can't express
the query (typical cases: complex pagination with `OFFSET`, partial-index
hint, `INSERT ON CONFLICT` shape).

## Step 6 — Test

Add a unit/integration test that exercises the new table or column.
Migration tests are usually integration:

```ts
// tests/integration/widget.test.ts
test('widget migration applies cleanly to an empty DB', async () => {
  await using ctx = await freshTargetRoot();
  await boot({ targetRoot: ctx.dir, noServe: true });
  // Confirm via raw SQL or a query
});
```

## Step 7 — Update [docs/schema.md](../schema.md)

The schema reference doc should match the schema. Add:

- A row in the table-list with column descriptions.
- An update to the ERD diagram.
- Notes on indexes and partial-index conditions.
- An update to the lifecycle/state-machine section if the new column
  has a non-trivial lifecycle.

## Anti-patterns

- **Don't** edit a migration file after it's been applied to a developer
  DB or shipped to a user. Migrations are append-only — write a new one
  to fix mistakes.
- **Don't** skip Drizzle and write SQL directly in `migrations/` unless
  you have a reason. Drift between `schema.ts` and the SQL means future
  `drizzle-kit generate` will produce broken diffs.
- **Don't** include `schema_version` in `schema.ts`. The runner manages
  it. Drizzle would otherwise try to recreate it.
- **Don't** add a `NOT NULL` column to an existing table without a
  default. Existing rows would fail to satisfy the constraint at
  migration time.
- **Don't** rename a column casually. SQLite's column-rename support is
  limited; Drizzle generates a table rebuild. Renames also break every
  query and break grep-for-string searches across the codebase. If you
  must rename, do it in a single focused commit and grep both `*.ts`
  and `*.md`.

## Schema-version conventions

- The numeric prefix is monotonic; use `0NNN` (zero-padded to 4 digits)
  to match Drizzle's default.
- Filename body is descriptive but short. Drizzle picks "auto-name"
  based on the diff; rename if it's misleading.
- Migration content is wrapped in a transaction by the runner — you do
  not need to add `BEGIN`/`COMMIT`.

## See also

- [docs/schema.md](../schema.md) — the canonical schema reference.
- [src/db/queries.ts](../../src/db/queries.ts) — every query the rest of
  the code uses.
- [drizzle.config.ts](../../drizzle.config.ts) — generator config.
