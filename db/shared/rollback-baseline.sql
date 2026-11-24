-- Undo the baseline: drop everything project_migrator created in the project schema (tables, the view,
-- functions, types, sequences, Prisma's _prisma_migrations) and its default privileges. The schema, the
-- roles and the grants from roles.sql stay, so the baseline can be applied again.
-- Run as project_migrator, in one transaction. Touches nothing outside project.
--   psql "<project_migrator connection>" -v ON_ERROR_STOP=1 -f db/shared/rollback-baseline.sql (plain SQL)

BEGIN;

DO $$
DECLARE r record;
BEGIN
  -- Views first, then tables (CASCADE takes their indexes, policies, triggers and sequences)
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'project' AND c.relkind IN ('v', 'm') AND pg_get_userbyid(c.relowner) = 'project_migrator'
  LOOP
    EXECUTE format('DROP %s IF EXISTS project.%I CASCADE', CASE r.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END, r.relname);
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'project' AND c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) = 'project_migrator'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS project.%I CASCADE', r.relname);
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'project' AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) = 'project_migrator'
  LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS project.%I CASCADE', r.relname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'project' AND pg_get_userbyid(p.proowner) = 'project_migrator'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.fn);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'project' AND t.typtype IN ('e', 'c', 'd') AND pg_get_userbyid(t.typowner) = 'project_migrator'
             AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS project.%I CASCADE', r.typname);
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA project REVOKE ALL ON TABLES FROM project_user, project_anon, project_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA project REVOKE ALL ON SEQUENCES FROM project_user, project_anon, project_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA project REVOKE ALL ON FUNCTIONS FROM project_user, project_anon, project_system;

COMMIT;
