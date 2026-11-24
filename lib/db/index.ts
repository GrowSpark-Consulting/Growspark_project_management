/**
 * Server-side database access over a direct Postgres connection (Prisma 7 + node-postgres).
 *
 * - withUser(userId, fn): runs fn in one transaction as the signed-in user. The transaction switches
 *   to DB_USER_ROLE, a role that does not bypass row-level security, and sets the JWT claims that
 *   auth.uid() and auth.role() read. Every policy and rule trigger therefore applies exactly as it
 *   does for requests through Supabase today.
 * - withSystem(fn): runs fn in one transaction for server work done after the API has checked access
 *   (what the service-role client does today): as DB_SYSTEM_ROLE when set (the shared database's
 *   project_system, allowed by explicit policies), otherwise as the connection's own login.
 *
 * Settings for the shared database (all optional; unset keeps today's behaviour on Supabase):
 *   DB_SCHEMA               schema of the app's tables (project); Prisma models and the query layer follow it
 *   DB_USER_ROLE / DB_ANON_ROLE / DB_SYSTEM_ROLE   project_user / project_anon / project_system
 *   DB_STATEMENT_TIMEOUT_MS each request's statement timeout (8000 on the shared database)
 *
 * All settings are transaction-local, so a pooled connection never carries a user to the next request.
 * Server-only: importing this from a client component fails, because node-postgres needs Node.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated/client';
import { isFrontendOnly, refuseDataAccess } from '../frontend-mode';

export type Tx = Prisma.TransactionClient;
export { Prisma };

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 15_000;

type Options = { organizationId?: string; timeoutMs?: number };

const cache = globalThis as unknown as { __pmPrisma?: PrismaClient };

/** The shared client. Created on first use, and kept across hot reloads in development. */
export function db(): PrismaClient {
  if (!cache.__pmPrisma) {
    if (isFrontendOnly()) refuseDataAccess('The database');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    // Sized for one long-running server (Render) behind Supabase's session pooler, where every app
    // and Supabase itself share the plan's connection limit (60 on the Free plan).
    const adapter = new PrismaPg(
      {
        connectionString,
        max: Number(process.env.DB_POOL_MAX) || 5,
        idleTimeoutMillis: 30_000, // hand idle connections back to the pooler
        connectionTimeoutMillis: 10_000, // fail fast when the database cannot be reached
      },
      schemaName() ? { schema: schemaName() } : undefined,
    );
    cache.__pmPrisma = new PrismaClient({ adapter });
  }
  return cache.__pmPrisma;
}

/** The app's schema when it is not `public` (DB_SCHEMA), else undefined. */
export function schemaName(): string | undefined {
  const schema = process.env.DB_SCHEMA;
  if (!schema || schema === 'public') return undefined;
  if (!ROLE_NAME.test(schema)) throw new Error('DB_SCHEMA is not a valid schema name');
  return schema;
}

/** Each request's statement timeout (DB_STATEMENT_TIMEOUT_MS), set inside its transaction. */
async function setLimits(tx: Tx): Promise<void> {
  const ms = Number(process.env.DB_STATEMENT_TIMEOUT_MS);
  if (Number.isInteger(ms) && ms > 0) await tx.$executeRawUnsafe(`set local statement_timeout = ${ms}`);
}

/** Role server jobs run as (DB_SYSTEM_ROLE), or undefined to run as the connection's login. */
export function systemRole(): string | undefined {
  const role = process.env.DB_SYSTEM_ROLE;
  if (!role) return undefined;
  if (!ROLE_NAME.test(role)) throw new Error('DB_SYSTEM_ROLE is not a valid role name');
  return role;
}

/** Role each user request runs as: `authenticated` on Supabase, an app-specific role elsewhere. */
export function userRole(): string {
  const role = process.env.DB_USER_ROLE || 'authenticated';
  if (!ROLE_NAME.test(role)) throw new Error('DB_USER_ROLE is not a valid role name');
  return role;
}

/** Run fn as the signed-in user, with row-level security applied. */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>, options: Options = {}): Promise<T> {
  if (!UUID.test(userId)) throw new Error('withUser needs the user id (a uuid)');
  if (options.organizationId !== undefined && !UUID.test(options.organizationId)) {
    throw new Error('organizationId must be a uuid');
  }
  const role = userRole();
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  return db().$transaction(
    async (tx) => {
      // The role name is checked above; it cannot be passed as a query parameter.
      await tx.$executeRawUnsafe(`set local role "${role}"`);
      await setLimits(tx);
      await tx.$queryRaw`select set_config('request.jwt.claims', ${claims}, true),
                                set_config('request.jwt.claim.sub', ${userId}, true),
                                set_config('request.jwt.claim.role', 'authenticated', true),
                                set_config('app.organization_id', ${options.organizationId ?? ''}, true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
}

/** Role signed-out requests run as (`anon` on Supabase), so row-level security applies to them too. */
export function anonRole(): string {
  const role = process.env.DB_ANON_ROLE || 'anon';
  if (!ROLE_NAME.test(role)) throw new Error('DB_ANON_ROLE is not a valid role name');
  return role;
}

/** Run fn with no signed-in user, as the anonymous role (row-level security applies). */
export async function withAnon<T>(fn: (tx: Tx) => Promise<T>, options: Pick<Options, 'timeoutMs'> = {}): Promise<T> {
  const role = anonRole();
  return db().$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`set local role "${role}"`);
      await setLimits(tx);
      await tx.$queryRaw`select set_config('request.jwt.claims', ${JSON.stringify({ role: 'anon' })}, true),
                                set_config('request.jwt.claim.role', 'anon', true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
}

/** Run fn as the server itself (no user). Only after the API has checked the caller's access. */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>, options: Pick<Options, 'timeoutMs'> = {}): Promise<T> {
  const role = systemRole();
  return db().$transaction(
    async (tx) => {
      if (role) await tx.$executeRawUnsafe(`set local role "${role}"`);
      await setLimits(tx);
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
}
