import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  // We don't run drizzle-kit migrate at runtime — our own migrate() in db/index.ts
  // applies the SQL files. This config is just for `drizzle-kit generate`.
});
