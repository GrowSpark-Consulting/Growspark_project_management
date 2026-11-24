-- Undo roles.sql: back to the state of 2026-11-23 (empty project schema; project_app with USAGE and CREATE
-- on it, search_path project, no connection limit). Run as postgres, AFTER rollback-baseline.sql (the roles
-- must own nothing). One transaction; touches nothing outside our names.
--   psql "<postgres connection>" -v ON_ERROR_STOP=1 -f db/shared/rollback-roles.sql

BEGIN;

REVOKE project_user, project_anon, project_system FROM project_app;
REVOKE ALL ON SCHEMA project FROM project_user, project_anon, project_system, project_migrator;

DROP ROLE project_user;
DROP ROLE project_anon;
DROP ROLE project_system;
DROP ROLE project_migrator;

GRANT USAGE, CREATE ON SCHEMA project TO project_app;
ALTER ROLE project_app CONNECTION LIMIT -1;

COMMIT;
