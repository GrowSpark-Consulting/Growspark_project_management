#!/usr/bin/env tsx
/**
 * Find, lock or delete the built-in test/demo accounts (*@test.local).
 *
 * These accounts are created by scripts/create-seed-users.ts and lib/demo-mode.ts
 * with the shared password "Test1234!", which is written in this repository's source.
 * They must never exist on a production database.
 *
 * Uses the Supabase project configured in .env.local
 * (SUPABASE_SERVER_URL or NEXT_PUBLIC_SUPABASE_URL, plus SUPABASE_SERVICE_ROLE_KEY).
 *
 * Usage:
 *   npm run security:test-users            # list only, changes nothing
 *   npm run security:test-users -- --lock    # random password + ban (keeps their data)
 *   npm run security:test-users -- --delete  # delete the accounts
 */

import { randomBytes } from 'crypto';
import { loadEnvConfig } from '@next/env';
import { createClient, type User } from '@supabase/supabase-js';

loadEnvConfig(process.cwd());

const TEST_EMAIL_SUFFIX = '@test.local';
const mode = process.argv.includes('--delete') ? 'delete' : process.argv.includes('--lock') ? 'lock' : 'list';

const url = process.env.SUPABASE_SERVER_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_SERVER_URL) or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function findTestUsers(): Promise<User[]> {
  const found: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    found.push(...data.users.filter((u) => u.email?.toLowerCase().endsWith(TEST_EMAIL_SUFFIX)));
    if (data.users.length < 1000) break;
  }
  return found;
}

async function main() {
  console.log(`Supabase: ${new URL(url!).host}`);
  const users = await findTestUsers();
  if (users.length === 0) {
    console.log(`OK: no ${TEST_EMAIL_SUFFIX} accounts found.`);
    return;
  }

  console.log(`Found ${users.length} test account(s):`);
  for (const u of users) console.log(`  - ${u.email}  (last sign-in: ${u.last_sign_in_at ?? 'never'})`);

  if (mode === 'list') {
    console.log('\nNothing changed. Re-run with --lock (keep data) or --delete (remove accounts).');
    return;
  }

  let failed = 0;
  for (const u of users) {
    const { error } =
      mode === 'delete'
        ? await supabase.auth.admin.deleteUser(u.id)
        : await supabase.auth.admin.updateUserById(u.id, {
            password: randomBytes(32).toString('base64url'),
            ban_duration: '876000h', // ~100 years
          });
    if (error) {
      failed++;
      console.error(`  FAILED ${u.email}: ${error.message}`);
    } else {
      console.log(`  ${mode === 'delete' ? 'deleted' : 'locked'} ${u.email}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} account(s) failed.${mode === 'delete' ? ' Records linked to them may block deletion; use --lock instead.' : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
