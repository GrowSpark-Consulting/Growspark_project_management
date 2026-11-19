/**
 * Project budget, hourly rate and currency (table public.project_financials).
 *
 * These values are kept out of the projects row so that people who can read a
 * project (employees, clients through the server) never receive them. Always
 * read them with the caller's own Supabase client (ctx.supabase): row-level
 * security returns rows only to project managers of the project and org-wide
 * viewers (view_all_projects). Writes are allowed for project managers only.
 *
 * Money is Decimal(14,2) plus an ISO currency code (GSC platform rule).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ProjectFinancials {
  budget: number | null;
  hourly_rate: number | null;
  currency: string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Budget/rate/currency for the given projects that the caller is allowed to see (others are omitted). */
export async function loadFinancials(db: any, projectIds: string[]): Promise<Record<string, ProjectFinancials>> {
  if (!projectIds.length) return {};
  const { data, error } = await db
    .from('project_financials')
    .select('project_id, budget, hourly_rate, currency')
    .in('project_id', projectIds);
  if (error) throw error;
  const out: Record<string, ProjectFinancials> = {};
  for (const row of data || []) {
    out[row.project_id] = { budget: num(row.budget), hourly_rate: num(row.hourly_rate), currency: row.currency || null };
  }
  return out;
}

/** Create or update budget / hourly rate / currency. Only the provided fields are changed. */
export async function saveFinancials(
  db: any,
  projectId: string,
  values: { budget?: number | null; hourly_rate?: number | null; currency?: string | null },
  userId: string
): Promise<ProjectFinancials> {
  const row: Record<string, unknown> = { project_id: projectId, updated_by: userId, updated_at: new Date().toISOString() };
  if (values.budget !== undefined) row.budget = values.budget;
  if (values.hourly_rate !== undefined) row.hourly_rate = values.hourly_rate;
  if (values.currency) row.currency = values.currency.toUpperCase();
  const { data, error } = await db
    .from('project_financials')
    .upsert(row, { onConflict: 'project_id' })
    .select('budget, hourly_rate, currency')
    .single();
  if (error) throw error;
  return { budget: num(data?.budget), hourly_rate: num(data?.hourly_rate), currency: data?.currency || null };
}
