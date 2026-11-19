'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Download rows (array of flat objects) as a UTF-8 CSV file. */
export function downloadCsv(rows: Record<string, any>[], filename: string) {
  if (!rows.length) return;
  const headerSet = new Set<string>();
  for (const r of rows) Object.keys(r).forEach((k) => headerSet.add(k));
  const headers = Array.from(headerSet);
  const escape = (v: any) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
