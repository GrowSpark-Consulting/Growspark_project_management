/**
 * Where uploaded files live. Server only.
 *
 * - Cloudflare R2 (private bucket, S3-compatible API) when the R2 settings are present:
 *     R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *     optional R2_ENDPOINT (EU jurisdiction, or a local S3-compatible server for tests) and R2_REGION (default "auto")
 * - otherwise the private Supabase Storage bucket "project-files" (local development).
 *
 * Partial R2 settings are a configuration error (never a silent fallback to Supabase).
 * Object keys are the same on both: "{project_id}/{file_id}/{file_name}" and "branding/logo-....png".
 * Nothing is public: downloads go through a short-lived signed link created after the app's own access check.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

export const SUPABASE_BUCKET = 'project-files';
const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

export type R2Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };

export class StorageConfigError extends Error {}

/** null = use Supabase Storage. Throws when R2 is only partly configured. */
export function r2ConfigFrom(env: Record<string, string | undefined> = process.env): R2Config | null {
  const has = (k: string) => !!env[k]?.trim();
  if (![...R2_KEYS, 'R2_ENDPOINT'].some(has)) return null;
  // With an explicit endpoint the account id is not needed to build the URL
  const missing = R2_KEYS.filter((k) => !has(k) && !(k === 'R2_ACCOUNT_ID' && has('R2_ENDPOINT')));
  if (missing.length) throw new StorageConfigError(`Cloudflare R2 is partly configured; missing ${missing.join(', ')}`);
  return {
    endpoint: (env.R2_ENDPOINT?.trim() || `https://${env.R2_ACCOUNT_ID!.trim()}.r2.cloudflarestorage.com`).replace(/\/$/, ''),
    region: env.R2_REGION?.trim() || 'auto',
    bucket: env.R2_BUCKET!.trim(),
    accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
  };
}

/** Content-Disposition for a download, safe for any file name (RFC 6266 / 5987). */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface FileStore {
  readonly backend: 'r2' | 'supabase';
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Bytes of a stored object, or null if it does not exist. */
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Short-lived download link (attachment with the original file name). */
  signedDownloadUrl(key: string, fileName: string, expiresInSeconds: number): Promise<string>;
  /** Removes objects; missing objects are ignored. */
  remove(keys: string[]): Promise<void>;
}

export function r2Store(cfg: R2Config): FileStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Cloudflare's guidance for AWS SDK v3: only send/verify checksums when an operation requires them
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const notFound = (e: unknown) => {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
  };
  return {
    backend: 'r2',
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.length }));
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return true;
      } catch (e) {
        if (notFound(e)) return false;
        throw e;
      }
    },
    async signedDownloadUrl(key, fileName, expiresInSeconds) {
      return getSignedUrl(client, new GetObjectCommand({
        Bucket: cfg.bucket, Key: key, ResponseContentDisposition: attachmentDisposition(fileName),
      }), { expiresIn: expiresInSeconds });
    },
    async remove(keys) {
      // One request per key: works on R2 and every S3-compatible server without batch checksums
      for (const key of keys) await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function supabaseStore(admin: any): FileStore {
  const bucket = () => admin.storage.from(SUPABASE_BUCKET);
  return {
    backend: 'supabase',
    async put(key, bytes, contentType) {
      const { error } = await bucket().upload(key, bytes, { contentType, upsert: false });
      if (error) throw new Error(error.message);
    },
    async get(key) {
      const { data, error } = await bucket().download(key);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async exists(key) {
      return (await this.get(key)) !== null;
    },
    async signedDownloadUrl(key, fileName, expiresInSeconds) {
      const { data, error } = await bucket().createSignedUrl(key, expiresInSeconds, { download: fileName });
      if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not create a signed URL');
      return data.signedUrl;
    },
    async remove(keys) {
      if (keys.length) await bucket().remove(keys);
    },
  };
}

let cached: { key: string; store: FileStore } | null = null;

/** The configured file store. Pass the request's admin client when you have one (Supabase backend). */
export function fileStore(admin?: any): FileStore {
  const cfg = r2ConfigFrom();
  if (cfg) {
    const key = `${cfg.endpoint}|${cfg.bucket}|${cfg.accessKeyId}`;
    if (cached?.key !== key) cached = { key, store: r2Store(cfg) };
    return cached.store;
  }
  const client = admin ?? createAdminSupabaseClient();
  if (!client) throw new StorageConfigError('No file storage configured: set the R2 settings or SUPABASE_SERVICE_ROLE_KEY');
  return supabaseStore(client);
}
