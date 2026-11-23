// Prisma CLI configuration (Prisma 7). The app itself reads DATABASE_URL at runtime in lib/db.
// Locally the URL comes from .env.development.local (local Docker Supabase); elsewhere from the environment.
// Database structure still changes only through supabase/migrations; Prisma is used for queries.
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '.env.development.local', quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
