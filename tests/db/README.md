# Local database tests

These tests check the database layer (migrations, row-level security, triggers) and that the application code agrees with the schema. They run entirely on your machine, in memory, in a few seconds.

- **No Docker needed.** They use [PGlite](https://pglite.dev), PostgreSQL compiled to WebAssembly.
- **No hosted database is touched.** Nothing connects to Supabase, and no credentials are read.

## Prerequisites

- Node.js 18 or newer (tested with Node 22)
- Project dependencies installed: `npm install`. This installs the dev dependency `@electric-sql/pglite`, pinned to `0.2.17`.

## Commands

| Command | What it runs |
|---|---|
| `npm run test:db` | All four suites |
| `npm run test:db:rules` | Only the RLS / trigger checks |
| `npm run test:db:migrations` | Only the clean-database migration checks |
| `node tests/db/run.mjs schema-drift api-wiring` | Any combination of suites by name |
| `node tests/db/run.mjs --verbose` | Also list passing checks |

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Every check passed |
| 1 | At least one check is FAIL or ERROR |
| 2 | Unknown suite name |

## Suites

| Suite | File | What it checks |
|---|---|---|
| `migrations` | [suites/migrations.mjs](suites/migrations.mjs) | Starting from an empty database, every file in `supabase/migrations/` applies in order. The resulting schema contains the expected tables, triggers, RLS, bucket and columns, and no longer contains removed ones (for example `projects.budget`). |
| `rules` | [suites/rules.mjs](suites/rules.mjs) | Runs SQL as real users under RLS: superadmin, project manager, a second project manager on other projects, two employees, an outsider, an org-wide viewer and clients. Part 1 is the 66 checks from the 2026-11-19 audit. Part 2 is regression checks for fixes G-1 to G-6 and D-1 to D-3 (see [IMPLEMENTATION_CHECKLIST.md](../../IMPLEMENTATION_CHECKLIST.md)). |
| `schema-drift` | [suites/schema-drift.mjs](suites/schema-drift.mjs) | Scans every Supabase query in `app/`, `components/` and `lib/` (table, select list, filters, insert/update keys) against the schema built from the migrations. Fails on any table or column that no migration creates. Older known issues are listed in `KNOWN_PRE_EXISTING` and reported as "known", not hidden. |
| `api-wiring` | [suites/api-wiring.mjs](suites/api-wiring.mjs) | Every `/api/...` URL called from the UI resolves to a route file that exports that HTTP method. |

Each check reports **PASS**, **FAIL** (the rule did not hold; the database error or row count is shown) or **ERROR** (the check itself could not run). A failing or crashing check never stops the others. If a migration fails, the file, the database error and the SQL around the failing line are printed.

## Proving a check detects the problem

`DB_TEST_SKIP_MIGRATIONS` (comma-separated filename prefixes) leaves migrations out. For example, to see the rule checks fail without the 2026-11-19 fix migration, run this in PowerShell:

```powershell
$env:DB_TEST_SKIP_MIGRATIONS = '20261119000000'; node tests/db/run.mjs rules; Remove-Item Env:DB_TEST_SKIP_MIGRATIONS
```

The equivalent in bash:

```bash
DB_TEST_SKIP_MIGRATIONS=20261119000000 node tests/db/run.mjs rules
```

## How it works

1. [supabase-shim.sql](supabase-shim.sql) recreates the small part of Supabase that the migrations use: schemas `auth` / `extensions` / `storage`, roles `anon` / `authenticated` / `service_role`, `auth.uid()`, `auth.role()`, `auth.users` and `storage.buckets`. As in Supabase, `auth.uid()` and `auth.role()` come from the request JWT claims and are NULL without a JWT.
2. [lib/harness.mjs](lib/harness.mjs) creates a fresh database for each suite and applies the shim and then every migration. It provides these helpers:

| Helper | Runs SQL as |
|---|---|
| `asUser(uid, fn)` | Role `authenticated` with the JWT `sub` set; RLS applies |
| `asAnon(fn)` | Role `anon` |
| `asService(fn)` | Role `service_role`, like the server using the service-role key |
| `q(sql)` | The database owner with no JWT, like a migration or the SQL editor |

## What these tests do not cover

- **Supabase Auth, Storage objects and PostgREST.** The shim only imitates the parts the SQL needs. File uploads, signed URLs, login bans and the HTTP API are not exercised.
- **The Next.js API routes and pages at runtime.** Route logic is checked statically only (`api-wiring`, `schema-drift`). End-to-end runs against a migrated database are still required; see [PROJECT_MANAGEMENT_TEST_PLAN.md](../../PROJECT_MANAGEMENT_TEST_PLAN.md).
- **Differences between PGlite and the hosted database.** PGlite is real PostgreSQL, but the hosted project may have extensions, settings or manual changes that the migration files don't show. The real migration rehearsal must be on a staging copy of the database.
- **Timing-dependent behaviour.** Example: the 14-day edit window on time entries is only checked for today's entries.
