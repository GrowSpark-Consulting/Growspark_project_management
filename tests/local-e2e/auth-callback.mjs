// Password-reset link, end to end: the reset request as the browser makes it (one-time code verifier
// in the app's cookie), the email, Supabase's verify step, then GET /auth/callback on the app. With the
// frontend-only server in front (as on Vercel) the callback runs on the backend: the visitor must stay
// on the app's address and leave with a working session. Local Supabase only; the test account is
// removed at the end.
// Usage: node tests/local-e2e/auth-callback.mjs   (app running on port 3100)
import { createServerClient } from '@supabase/ssr';
import { loadEnv, adminClient, COOKIE_NAME, PASSWORD, call, payload } from './lib.mjs';

const env = loadEnv();
const admin = adminClient(env);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The local mail catcher is three ports above the Supabase API (54321 → 54324, 56321 → 56324)
const mailUrl = process.env.MAIL_URL || (() => { const u = new URL(env.url); u.port = String(Number(u.port) + 3); return u.origin; })();
const cookieHeader = (pairs) => pairs.map(([n, v]) => `${n}=${v}`).join('; ');

async function recoveryLink(to) {
  for (let i = 0; i < 30; i++) {
    const found = await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((r) => r.json()).catch(() => null);
    const id = found?.messages?.[0]?.ID;
    if (id) {
      const msg = await fetch(`${mailUrl}/api/v1/message/${id}`).then((r) => r.json());
      const text = `${msg.Text || ''} ${msg.HTML || ''}`.replace(/&amp;/g, '&');
      return text.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]*/)?.[0] ?? null;
    }
    await sleep(500);
  }
  return null;
}

console.log(`Password-reset link through ${env.appUrl}/auth/callback`);
const email = `callback-${Date.now()}@example.com`;
const { data: created, error: createError } = await admin.auth.admin.createUser({
  email, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Callback Test' },
});
if (createError) { console.error(`Could not create the test account: ${createError.message}`); process.exit(1); }
const userId = created.user.id;

try {
  console.log('\n▸ No code, wrong code');
  const none = await fetch(`${env.appUrl}/auth/callback`, { redirect: 'manual' });
  check('no code: back to the login page, on the app\'s address', none.status === 307 && none.headers.get('location') === '/login?error=no_code', `${none.status} → ${none.headers.get('location')}`);
  const wrong = await fetch(`${env.appUrl}/auth/callback?code=00000000-0000-0000-0000-000000000000&type=recovery`, { redirect: 'manual' });
  check('wrong code: login page with an error', wrong.status === 307 && wrong.headers.get('location') === '/login?error=auth_callback_failed', `${wrong.status} → ${wrong.headers.get('location')}`);

  console.log('\n▸ Reset request, email, link');
  const jar = new Map();
  const browser = createServerClient(env.url, env.anon, {
    cookieOptions: { name: COOKIE_NAME },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error: resetError } = await browser.auth.resetPasswordForEmail(email, { redirectTo: `${env.appUrl}/auth/callback?type=recovery` });
  check('reset requested; one-time code verifier kept in the app\'s cookie', !resetError && [...jar.keys()].some((k) => k.startsWith(`${COOKIE_NAME}-code-verifier`)), resetError?.message || [...jar.keys()].join(', '));

  const link = await recoveryLink(email);
  check('reset email arrived with a link', !!link);
  const verified = link ? await fetch(link, { redirect: 'manual' }) : null;
  const landing = verified?.headers.get('location') || '';
  const code = landing ? new URL(landing).searchParams.get('code') : null;
  check('link verified by Supabase, code handed to the app', !!code, landing.replace(/code=[^&]+/, 'code=…'));

  console.log('\n▸ Callback');
  const res = await fetch(`${env.appUrl}/auth/callback?code=${encodeURIComponent(code || '')}&type=recovery`, {
    redirect: 'manual', headers: { cookie: cookieHeader([...jar]) },
  });
  check('callback sends the visitor to /reset-password, on the app\'s address', res.status === 307 && res.headers.get('location') === '/reset-password', `${res.status} → ${res.headers.get('location')}`);
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]);
  const session = set.filter(([name, value]) => name.startsWith(COOKIE_NAME) && !name.includes('code-verifier') && value);
  check('session cookie set under the app\'s cookie name', session.length > 0, session.map(([n]) => n).join(', ') || set.map(([n]) => n).join(', ') || 'none');

  const me = await call(env, { cookie: cookieHeader(session) }, 'GET', '/api/me/profile');
  const profile = payload(me);
  check('that session works: the API knows the visitor', me.status === 200 && (profile?.email === email || profile?.profile?.email === email), `${me.status}`);
} finally {
  await admin.auth.admin.deleteUser(userId).catch(() => {});
}

const failed = results.filter((ok) => !ok).length;
console.log(`\nPassword-reset link (auth callback): ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
