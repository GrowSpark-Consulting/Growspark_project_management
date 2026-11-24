/**
 * The server-side database layer (lib/db) against the LOCAL Supabase database: DATABASE_URL from
 * .env.development.local. Skipped when it is missing or unreachable, and never runs against anything
 * but localhost. Changes nothing: the only write it tries is refused by row-level security.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { withUser, withSystem, db, userRole } from '@/lib/db';

config({ path: path.resolve(__dirname, '..', '..', process.env.LOCAL_ENV_FILE || '.env.development.local'), quiet: true });
// On the shared database the user comes from project.current_user_id() / request_role(), not auth.*
const SHARED = (process.env.DB_SCHEMA || 'public') !== 'public';
const UID = SHARED ? 'project.current_user_id()' : 'auth.uid()';
const ROLE = SHARED ? 'project.request_role()' : 'auth.role()';
const url = process.env.DATABASE_URL;
const local = !!url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);

let reachable = false;
if (local) {
  const probe = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await probe.connect();
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end().catch(() => {});
  }
}

type Who = { uid: string | null; role: string | null; current_user: string; bypass: boolean };

describe.skipIf(!reachable)('server-side database layer (lib/db)', () => {
  afterAll(async () => {
    await db().$disconnect();
  });

  it('runs as the user: auth.uid() and auth.role() see the user, and the role cannot bypass row-level security', async () => {
    const id = randomUUID();
    const [who] = await withUser(id, (tx) => tx.$queryRawUnsafe<Who[]>(
      `select ${UID}::text as uid, ${ROLE} as role, current_user::text as current_user,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass`));
    expect(who).toEqual({ uid: id, role: 'authenticated', current_user: userRole(), bypass: false });
  });

  it('leaves nothing behind on the pooled connection', async () => {
    for (let i = 0; i < 3; i++) {
      await withUser(randomUUID(), (tx) => tx.$queryRaw`select 1`);
      const [after] = await withSystem((tx) => tx.$queryRaw<{ current_user: string; sub: string }[]>`
        select current_user::text as current_user, coalesce(current_setting('request.jwt.claim.sub', true), '') as sub`);
      expect(after.current_user).not.toBe(userRole());
      expect(after.sub).toBe('');
    }
  });

  it('applies row-level security: a stranger sees no projects and changes none', async () => {
    const stranger = randomUUID();
    const total = await withSystem((tx) => tx.projects.count());
    expect(await withUser(stranger, (tx) => tx.projects.count())).toBe(0);
    expect(await withUser(stranger, (tx) => tx.$executeRaw`update projects set name = name`)).toBe(0);
    expect(await withSystem((tx) => tx.projects.count())).toBe(total);
  });

  it('keeps concurrent users apart', async () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const seen = await Promise.all(ids.map((id) =>
      withUser(id, async (tx) => (await tx.$queryRawUnsafe<{ uid: string }[]>(`select ${UID}::text as uid from pg_sleep(0.05)`))[0].uid)));
    expect(seen).toEqual(ids);
  });

  it('sets the organization for the transaction only', async () => {
    const org = randomUUID();
    const [inside] = await withUser(randomUUID(), (tx) => tx.$queryRaw<{ org: string }[]>`
      select current_setting('app.organization_id', true) as org`, { organizationId: org });
    expect(inside.org).toBe(org);
    const [outside] = await withSystem((tx) => tx.$queryRaw<{ org: string }[]>`
      select coalesce(current_setting('app.organization_id', true), '') as org`);
    expect(outside.org).toBe('');
  });

  it('refuses a bad user id or role name', async () => {
    await expect(withUser('not-a-uuid', async () => 1)).rejects.toThrow(/uuid/);
    const saved = process.env.DB_USER_ROLE;
    process.env.DB_USER_ROLE = 'authenticated; drop table projects';
    try {
      expect(() => userRole()).toThrow(/role name/);
    } finally {
      if (saved === undefined) delete process.env.DB_USER_ROLE;
      else process.env.DB_USER_ROLE = saved;
    }
  });
});
