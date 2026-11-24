-- REHEARSAL ONLY. Recreates, on the local rehearsal stack, what the shared database has today for us and
-- the Sales CRM (from the read-only inventory of 2026-11-23), so roles.sql and the baseline are tested
-- against the same starting point and restrictions. Never run on the shared database.
-- Run as postgres. Local-only passwords.

BEGIN;

-- Ours, exactly as bootstrapped on 2026-11-23
CREATE SCHEMA project;
REVOKE ALL ON SCHEMA project FROM public;
CREATE ROLE project_app LOGIN PASSWORD 'rehearsal-only';
GRANT USAGE, CREATE ON SCHEMA project TO project_app;
ALTER ROLE project_app SET search_path = project;

-- Another app's schema and login (like sales / sales_app), to prove isolation
CREATE SCHEMA sales;
REVOKE ALL ON SCHEMA sales FROM public;
CREATE ROLE sales_app LOGIN PASSWORD 'rehearsal-only';
GRANT USAGE, CREATE ON SCHEMA sales TO sales_app;
ALTER ROLE sales_app SET search_path = sales;
CREATE TABLE sales.companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
INSERT INTO sales.companies (name) VALUES ('Sales CRM private row');

COMMIT;
