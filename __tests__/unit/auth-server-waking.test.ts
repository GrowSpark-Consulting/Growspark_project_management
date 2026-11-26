import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Signed in as far as Supabase Auth is concerned; only the app's own API is in question
vi.mock('@/lib/supabase', () => ({
  createClientSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  }),
}));

import { getCurrentUserProfile, ServerUnavailableError } from '@/lib/auth';

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('loading the profile while the API server wakes from sleep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('waits through 502/503 and network errors, then returns the profile', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answer(502))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(answer(503))
      .mockResolvedValueOnce(answer(200, { data: { id: 'user-1', name: 'Ada' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = getCurrentUserProfile();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ id: 'user-1', name: 'Ada' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a real "not signed in" answer is not retried and gives no profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(401, { error: 'Not signed in' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentUserProfile()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a server that never wakes is reported as unavailable (so the session is kept), not as a missing profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(502));
    vi.stubGlobal('fetch', fetchMock);

    const result = getCurrentUserProfile();
    const outcome = expect(result).rejects.toBeInstanceOf(ServerUnavailableError);
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
  });
});
