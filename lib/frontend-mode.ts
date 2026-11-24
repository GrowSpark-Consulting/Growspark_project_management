/**
 * Frontend-only server (Vercel): BACKEND_URL names the API server (Render). Every /api request is
 * forwarded there (next.config.ts), and server-rendered pages load their data from its /api/pages
 * endpoints (lib/page-data.ts). Such a server holds no database credentials, so a direct data read
 * there is a bug: the data clients refuse instead of quietly reading some other database.
 * Unset (Render, local): this server has the database and does everything itself.
 */
export function backendUrl(): string | null {
  return process.env.BACKEND_URL?.trim().replace(/\/$/, '') || null;
}

export function isFrontendOnly(): boolean {
  return backendUrl() !== null;
}

export function refuseDataAccess(what: string): never {
  throw new Error(`${what} is not available on the frontend server; data comes from the backend API (BACKEND_URL)`);
}
