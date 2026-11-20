#!/usr/bin/env node
// Copy existing files from the Supabase Storage bucket "project-files" into the Cloudflare R2 bucket,
// keeping the same object keys, so the records in project_files (and the company logo) keep working
// once the app's R2 settings are switched on. See docs/file-storage-r2.md.
//
//   node --env-file=<your env file> scripts/copy-files-to-r2.mjs           # preview: what would be copied
//   node --env-file=<your env file> scripts/copy-files-to-r2.mjs --apply   # copy
//
// Reads SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY and the app's R2 settings
// (R2_ACCOUNT_ID or R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, optional R2_REGION).
// Safe to run again: objects already in R2 with the same size are skipped. Nothing is ever deleted
// from Supabase Storage, so switching back is just removing the R2 settings.
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = 'project-files';
const apply = process.argv.includes('--apply');
const env = process.env;

function fail(msg) { console.error(msg); process.exit(2); }

const supabaseUrl = env.SUPABASE_SERVER_URL || env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl || !env.SUPABASE_SERVICE_ROLE_KEY) fail('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.');
const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k) => !env[k]?.trim());
if (!env.R2_ENDPOINT?.trim() && !env.R2_ACCOUNT_ID?.trim()) missing.unshift('R2_ACCOUNT_ID (or R2_ENDPOINT)');
if (missing.length) fail(`Missing R2 settings: ${missing.join(', ')}`);

const endpoint = (env.R2_ENDPOINT?.trim() || `https://${env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`).replace(/\/$/, '');
const r2Bucket = env.R2_BUCKET.trim();
const s3 = new S3Client({
  endpoint,
  region: env.R2_REGION?.trim() || 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID.trim(), secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim() },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const supabase = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Every object in the Supabase bucket: [{ key, size, contentType }] */
async function listAll(prefix = '') {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`Listing "${prefix || '/'}" failed: ${error.message}`);
    for (const entry of data) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) out.push(...(await listAll(key))); // a folder
      else out.push({ key, size: Number(entry.metadata?.size ?? -1), contentType: entry.metadata?.mimetype || 'application/octet-stream' });
    }
    if (data.length < 1000) break;
  }
  return out;
}

async function sizeInR2(key) {
  try {
    return (await s3.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }))).ContentLength ?? -1;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
    throw e;
  }
}

console.log(`${apply ? 'Copying' : 'Preview (add --apply to copy)'}: Supabase Storage "${BUCKET}" → R2 bucket "${r2Bucket}" at ${new URL(endpoint).host}`);
const objects = await listAll();
let already = 0, copied = 0, failed = 0, toCopy = 0;
for (const o of objects) {
  try {
    const existing = await sizeInR2(o.key);
    if (existing !== null && existing === o.size) { already++; continue; }
    toCopy++;
    if (!apply) { console.log(`  would copy  ${o.key}  (${o.size} bytes)`); continue; }
    const { data, error } = await supabase.storage.from(BUCKET).download(o.key);
    if (error || !data) throw new Error(error?.message || 'download failed');
    const body = Buffer.from(await data.arrayBuffer());
    await s3.send(new PutObjectCommand({ Bucket: r2Bucket, Key: o.key, Body: body, ContentType: o.contentType, ContentLength: body.length }));
    const after = await sizeInR2(o.key);
    if (after !== body.length) throw new Error(`size check failed (R2 has ${after}, expected ${body.length})`);
    copied++;
    console.log(`  copied      ${o.key}  (${body.length} bytes)`);
  } catch (e) {
    failed++;
    console.error(`  FAILED      ${o.key}: ${e.message}`);
  }
}
console.log(`\n${objects.length} object(s) in Supabase Storage: ${already} already in R2, ${apply ? `${copied} copied` : `${toCopy} to copy`}, ${failed} failed.`);
process.exit(failed ? 1 : 0);
