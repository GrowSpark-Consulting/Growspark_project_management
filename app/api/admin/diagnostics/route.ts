import { z } from 'zod';
import { api, ok, readJson } from '@/lib/api/context';
import { uuidSchema } from '@/lib/validation-schemas';
import { assignSuperadminRoleByEmail, checkSuperadminRoleByEmail, removeSuperadminRoleByEmail } from '@/lib/superadmin-utils';
import { testDatabaseConnection } from '@/lib/test-database';
import { checkDatabaseSchema, testUserProfileCreation } from '@/lib/database-check';

// POST /api/admin/diagnostics: the superadmin setup page's role tools and the database status checks
// (moved off browser queries). Each runs the same function as before, on the server as the signed-in
// user, so row-level security decides what it may read and change, as it did in the browser.
const email = z.string().trim().email().max(320);
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign-superadmin'), email }),
  z.object({ action: z.literal('check-superadmin'), email }),
  z.object({ action: z.literal('remove-superadmin'), email }),
  z.object({ action: z.literal('test-connection') }),
  z.object({ action: z.literal('check-schema') }),
  z.object({ action: z.literal('test-profile-creation'), userId: uuidSchema, email, name: z.string().trim().min(1).max(200) }),
]);

export const POST = api(async (request, ctx) => {
  const b = await readJson(request, body);
  const db = ctx.supabase;
  switch (b.action) {
    case 'assign-superadmin': return ok(await assignSuperadminRoleByEmail(b.email, db));
    case 'check-superadmin': return ok(await checkSuperadminRoleByEmail(b.email, db));
    case 'remove-superadmin': return ok(await removeSuperadminRoleByEmail(b.email, db));
    case 'test-connection': return ok(await testDatabaseConnection(db));
    case 'check-schema': return ok(await checkDatabaseSchema(db));
    case 'test-profile-creation': return ok(await testUserProfileCreation(b.userId, b.email, b.name, db));
  }
});
