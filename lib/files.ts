/**
 * Project files: the bytes live in private object storage (Cloudflare R2 when configured, otherwise
 * the Supabase Storage bucket "project-files"; see lib/file-storage.ts), the record in project_files.
 * Only the server touches objects; users download through 60-second signed links after an access check.
 */
import { NextRequest, NextResponse } from 'next/server';
import { HttpError, check } from '@/lib/api/context';
import { fileStore } from '@/lib/file-storage';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_LINK_SECONDS = 60;

const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'csv', 'md',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'zip', 'json',
]);

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'file';
}

export async function readUpload(request: NextRequest): Promise<{ file: File; fields: FormData }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'Expected multipart/form-data with a "file" field');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'No file uploaded');
  if (file.size <= 0) throw new HttpError(400, 'File is empty');
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, 'File is larger than 10 MB');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new HttpError(415, `File type .${ext || '?'} is not allowed`);
  return { file, fields: form };
}

export async function storeProjectFile(
  admin: any,
  opts: { projectId: string; taskId?: string | null; file: File; uploadedBy: string; clientVisible?: boolean }
) {
  const id = crypto.randomUUID();
  const name = safeName(opts.file.name);
  const path = `${opts.projectId}/${id}/${name}`;
  const bytes = Buffer.from(await opts.file.arrayBuffer());
  const store = fileStore(admin);
  try {
    await store.put(path, bytes, opts.file.type || 'application/octet-stream');
  } catch (e) {
    throw new HttpError(500, `Upload failed: ${(e as Error).message}`);
  }
  const { data, error } = await admin.from('project_files').insert({
    id,
    project_id: opts.projectId,
    task_id: opts.taskId || null,
    file_name: name,
    storage_path: path,
    mime_type: opts.file.type || null,
    size_bytes: opts.file.size,
    client_visible: !!opts.clientVisible,
    uploaded_by: opts.uploadedBy,
  }).select('*').single();
  if (error) {
    await store.remove([path]).catch(() => undefined);
    throw error;
  }
  return data;
}

export async function signedDownload(admin: any, file: { storage_path: string; file_name: string }) {
  let url: string;
  try {
    url = await fileStore(admin).signedDownloadUrl(file.storage_path, file.file_name, DOWNLOAD_LINK_SECONDS);
  } catch {
    throw new HttpError(500, 'Could not create download link');
  }
  return NextResponse.redirect(url, 302);
}

export async function deleteProjectFile(admin: any, file: { id: string; storage_path: string }) {
  await fileStore(admin).remove([file.storage_path]);
  check(await admin.from('project_files').delete().eq('id', file.id));
}

export async function removeProjectFolder(admin: any, projectId: string) {
  const { data } = await admin.from('project_files').select('storage_path').eq('project_id', projectId);
  const paths = (data || []).map((f: any) => f.storage_path);
  if (paths.length) await fileStore(admin).remove(paths);
}
