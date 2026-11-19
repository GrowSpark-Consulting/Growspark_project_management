'use client';
/**
 * Browser helpers for the JSON API. Errors carry the server's message.
 */

export class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiRequestError(res.status, body?.error || `Request failed (${res.status})`);
  return body as T;
}

/** GET returning the whole JSON body ({ data, meta } for new endpoints). */
export async function apiGet<T = any>(url: string): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return parse<T>(await fetch(url, { credentials: 'include' }));
}

export async function apiSend<T = any>(url: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return parse<T>(await fetch(url, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

export async function apiUpload<T = any>(url: string, file: File, extra?: Record<string, string>): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const form = new FormData();
  form.append('file', file);
  Object.entries(extra || {}).forEach(([k, v]) => form.append(k, v));
  return parse<T>(await fetch(url, { method: 'POST', body: form, credentials: 'include' }));
}

/** SWR fetcher that returns the full JSON body. */
export const jsonFetcher = (url: string) => apiGet(url);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * Money with the currency symbol and Indian digit grouping (Grow Spark Workspace rule):
 * formatMoney(482000, 'INR') -> "₹4,82,000". Whole amounts show no decimals.
 */
export function formatMoney(amount: number | null | undefined, currency = 'INR'): string {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—';
  const value = Number(amount);
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('en-IN')}`;
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}
