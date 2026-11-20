// Put the LOCAL installation back to "brand new" so you can register your own company at /signup.
//
// Runs `npx supabase db reset --local` (every migration + seed.sql: role templates and the settings
// row, no users). Local only: refuses unless the Supabase URL is localhost/127.0.0.1 and you pass
// --reset-local-db. Refuses when the database holds accounts that aren't @example.com test accounts
// (for example a workspace you registered yourself) unless you also pass --wipe-local-accounts.
//
// Usage: npm run local:fresh -- --reset-local-db
// Afterwards: open http://localhost:3100 → you are sent to /signup.
// Note: the E2E suites (npm run e2e:local, e2e:local:browser) re-create the @example.com test users;
// once they exist, registration is closed again (an installation with users can't be claimed).
import { loadEnv, resetLocalDb, call } from './lib.mjs';

if (!process.argv.includes('--reset-local-db')) {
  console.error('This deletes everything in the LOCAL Supabase database. Re-run with --reset-local-db to confirm.');
  process.exit(2);
}

const env = loadEnv(); // throws unless local
try {
  await resetLocalDb(env);
  const st = await call(env, null, 'GET', '/api/register').catch(() => null);
  if (!st) {
    console.log('Done. The app is not running on', env.appUrl, '- start it, then open /signup.');
  } else if (st.body?.data?.open) {
    console.log(`Done. Registration is open: open ${env.appUrl}/signup and create your company workspace.`);
  } else {
    console.log('Reset finished but registration is not open:', JSON.stringify(st.body));
    process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
