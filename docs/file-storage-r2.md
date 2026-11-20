# File storage on Cloudflare R2

Project files (task attachments, project documents, deliverable files, documents uploaded by clients) and the company logo are stored in a **private Cloudflare R2 bucket**. The database keeps only the record of each file (`project_files`: name, size, project, uploader, "show to client").

```
User uploads (max 10 MB, safe types) → server checks access → private R2 bucket, folder per project
Download → server checks access → signed link to R2, valid 60 seconds
```

- **The bucket is never public.** Every download goes through the app's access check, which then redirects to a signed link that expires after 60 seconds and works for that one file only.
- **Object keys** are `{project_id}/{file_id}/{file_name}` for project files and `branding/logo-<time>.<ext>` for the logo.
- **Which storage is used** (`lib/file-storage.ts`):
  - When the R2 settings below are present, files go to R2.
  - Without them (local development), the app uses the private Supabase Storage bucket `project-files`.
  - If the R2 settings are only partly filled in, the app refuses to start file operations. It does not silently fall back to Supabase.

## 1. Create the bucket and an API token (Cloudflare dashboard)

1. **R2 → Create bucket**, for example `pm-files`. Choose a location (or the EU jurisdiction if you need data residency).
2. Leave **Public access** off. Don't connect a custom domain and don't enable the `r2.dev` URL.
3. **R2 → Manage API tokens → Create API token:**
   - Permissions: **Object Read & Write**.
   - Scope: **only the `pm-files` bucket**.
   - Copy the **Access Key ID** and **Secret Access Key** (shown once). Your **Account ID** is on the R2 overview page.

No CORS rules are needed: the browser never uploads to R2 directly, and downloads are ordinary link navigations.

## 2. App settings (server only)

```env
R2_ACCOUNT_ID=<account id>
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=pm-files
# Only for the EU jurisdiction (or a different S3-compatible endpoint):
# R2_ENDPOINT=https://<account id>.eu.r2.cloudflarestorage.com
```

These are secrets. Keep them in the server's environment only, never in a `NEXT_PUBLIC_*` variable or in git.

## 3. Switching an installation that already has files

1. **Preview** what will be copied. This reads Supabase Storage and changes nothing:
   ```bash
   node --env-file=<env file with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the R2 settings> scripts/copy-files-to-r2.mjs
   ```
2. **Copy:** add `--apply`. Each copy is checked by size. The script is safe to run again: files already in R2 are skipped.
3. **Switch on** by setting the R2 settings in the app's environment and restarting the app.
4. **Catch late uploads:** run the copy once more with `--apply`, to pick up anything uploaded between steps 2 and 3.
5. **Check:** download a few existing files and the company logo, and upload a new file.

**Going back** means removing the R2 settings and restarting. The script never deletes anything from Supabase Storage, so the old copies are still there. Files uploaded while R2 was on would have to be copied back by hand. Delete the old Supabase copies only once you are sure.

## 4. Testing locally

R2 speaks the S3 API, so the tests run against a local S3-compatible server that, like R2, checks signatures and link expiry:

```bash
docker run -d --name pm-r2-test -p 127.0.0.1:9100:9000 \
  -e RUSTFS_ACCESS_KEY=pmtestaccess -e RUSTFS_SECRET_KEY=pmtestsecret123 rustfs/rustfs:latest

R2_TEST_ENDPOINT=http://127.0.0.1:9100 R2_TEST_ACCESS_KEY_ID=pmtestaccess \
R2_TEST_SECRET_ACCESS_KEY=pmtestsecret123 npx vitest run __tests__/integration/r2-storage.test.ts
```

The test creates a temporary bucket and removes it. It checks:
- upload, read and delete;
- the bucket is private;
- signed downloads with the original file name;
- an expired or reused link is refused;
- `lib/files.ts` with R2 switched on.

Without `R2_TEST_ENDPOINT` the test is skipped. `__tests__/unit/file-storage.test.ts` covers the settings rules. To run the whole app on the local server, set `R2_ENDPOINT=http://127.0.0.1:9100`, `R2_REGION=us-east-1` and the test keys, and create the bucket first.
