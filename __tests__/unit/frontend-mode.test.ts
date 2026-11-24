// The frontend-only server (Vercel, BACKEND_URL set) holds no database credentials: the database and
// admin clients must refuse there, even when credentials happen to be present, and every server-rendered
// page's data must have a backend endpoint (GET /api/pages/<path>).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }));

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

describe('frontend-only server', () => {
  it('knows it is the frontend only when BACKEND_URL is set', async () => {
    const { isFrontendOnly, backendUrl } = await import('@/lib/frontend-mode');
    delete process.env.BACKEND_URL;
    expect(isFrontendOnly()).toBe(false);
    process.env.BACKEND_URL = ' https://api.example.com/ ';
    expect(isFrontendOnly()).toBe(true);
    expect(backendUrl()).toBe('https://api.example.com');
  });

  it('refuses the database even with a DATABASE_URL', async () => {
    process.env.BACKEND_URL = 'https://api.example.com';
    process.env.DATABASE_URL = 'postgresql://user:secret@127.0.0.1:5432/postgres';
    const { db } = await import('@/lib/db');
    expect(() => db()).toThrow(/not available on the frontend server/);
  });

  it('refuses the admin client even with a service key', async () => {
    process.env.BACKEND_URL = 'https://api.example.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    const { createAdminSupabaseClient } = await import('@/lib/supabase-server');
    expect(() => createAdminSupabaseClient()).toThrow(/not available on the frontend server/);
  });

  it('has a backend endpoint for every server-rendered page, and nothing else', async () => {
    const { loaderFor } = await import('@/lib/page-loaders');
    const id = '11111111-1111-1111-1111-111111111111';
    for (const path of [
      ['manager'], ['client-portal'], ['admin-workflows'], ['accounts'], ['accounts', id], ['departments'],
      ['departments', id], ['departments', id, 'admin'], ['workspace', 'growspark'],
      ['title', 'account', id], ['title', 'department', id], ['title', 'project', id],
    ]) {
      expect(loaderFor(path), path.join('/')).toBeTypeOf('function');
    }
    for (const path of [[], ['users'], ['accounts', id, 'extra'], ['accounts', id, 'admin', 'x'], ['departments', id, 'other'], ['title', 'user', id], ['title', 'project']]) {
      expect(loaderFor(path), path.join('/')).toBeNull();
    }
  });
});
