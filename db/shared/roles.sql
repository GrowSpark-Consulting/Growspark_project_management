-- Roles for Project Management on the shared GrowSpark database (growspark-workspace).
-- Run ONCE as postgres, before the baseline migration, in one transaction. Needs the project schema and the
-- project_app login that already exist there (see db/shared/rehearsal/mirror.sql for that starting point).
--
-- The project_migrator password is never stored: the runner replaces __MIGRATOR_PASSWORD__ when it runs
-- the file (scripts/shared-db/rehearse.mjs locally; on the shared database, a copy made at run time that is
-- deleted afterwards). Plain SQL only, so it also runs through the Supabase CLI login:
--   (no psql meta-commands or variables)
--
-- Afterwards:
--   project_migrator  login, owns every object in project, runs migrations, never used by the app
--   project_app       the app's login: may only switch to one of the three request roles (it inherits nothing)
--   project_user      signed-in requests      (row-level security applies)
--   project_anon      signed-out requests     (row-level security applies)
--   project_system    server jobs             (allowed by explicit allow-all policies, no RLS bypass)
-- Undo with db/shared/rollback-roles.sql (after db/shared/rollback-baseline.sql).

BEGIN;

CREATE ROLE project_migrator LOGIN PASSWORD '__MIGRATOR_PASSWORD__' CONNECTION LIMIT 2;
ALTER ROLE project_migrator SET search_path = project;

CREATE ROLE project_user NOLOGIN;
CREATE ROLE project_anon NOLOGIN;
CREATE ROLE project_system NOLOGIN;

-- The app switches role per request (SET LOCAL ROLE) but never inherits the roles' rights: without a switch
-- it can touch nothing in project
GRANT project_user, project_anon, project_system TO project_app WITH INHERIT FALSE, SET TRUE;

-- Schema rights (only the schema's owner can grant these). PUBLIC keeps nothing.
REVOKE ALL ON SCHEMA project FROM PUBLIC;
REVOKE CREATE, USAGE ON SCHEMA project FROM project_app;
GRANT USAGE, CREATE ON SCHEMA project TO project_migrator;
GRANT USAGE ON SCHEMA project TO project_user, project_anon, project_system;

-- Shared limits: a bug or a second server cannot take the other apps' connections
ALTER ROLE project_app CONNECTION LIMIT 10;

COMMIT;
