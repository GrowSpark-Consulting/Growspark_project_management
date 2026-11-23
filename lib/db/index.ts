/**
 * Server-side database access over a direct Postgres connection (Prisma 7 + node-postgres).
 *
 * - withUser(userId, fn): runs fn in one transaction as the signed-in user. The transaction switches
 *   to DB_USER_ROLE, a role that does not bypass row-level security, and sets the JWT claims that
 *   auth.uid() and auth.role() read. Every policy and rule trigger therefore applies exactly as it
 *   does for requests through Supabase today.
 * - withSystem(fn): runs fn in one transaction as the connection's own login, for server work done
 *   after the API has checked access (what the service-role client does today).
 *
 * Both settings are transaction-local, so a pooled connection never carries a user to the next request.
 * Server-only: importing this from a client component fails, because node-postgres needs Node.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated/client';

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
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    const adapter = new PrismaPg({ connectionString, max: Number(process.env.DB_POOL_MAX) || 10 });
    cache.__pmPrisma = new PrismaClient({ adapter });
  }
  return cache.__pmPrisma;
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
      await tx.$queryRaw`select set_config('request.jwt.claims', ${claims}, true),
                                set_config('request.jwt.claim.sub', ${userId}, true),
                                set_config('request.jwt.claim.role', 'authenticated', true),
                                set_config('app.organization_id', ${options.organizationId ?? ''}, true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
}

/** Run fn as the server itself (no user). Only after the API has checked the caller's access. */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>, options: Pick<Options, 'timeoutMs'> = {}): Promise<T> {
  return db().$transaction((tx) => fn(tx), { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
}
