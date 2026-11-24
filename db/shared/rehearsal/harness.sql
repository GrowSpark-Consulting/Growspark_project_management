-- REHEARSAL ONLY: lets the test suites seed and compare data through the local Data API (PostgREST) on the
-- project schema. The app itself does not use this path (it reaches the database as project_app, and the
-- Data-API-off proxy refuses /rest/v1 for it). Never run on the shared database, whose Data API is off.
-- PostgREST's roles take the matching request role, so row-level security behaves as it does for the app.

BEGIN;
GRANT USAGE ON SCHEMA project TO anon, authenticated, service_role;
GRANT project_user TO authenticated;
GRANT project_anon TO anon;
GRANT project_system TO service_role;
COMMIT;
