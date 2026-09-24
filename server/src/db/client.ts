import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { config } from '../config';
import * as schema from './schema';

/**
 * Single libsql client shared by every module. Turso when configured
 * (`DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`), a local SQLite file
 * otherwise (`file:…` — the default `file:./data/golive.db`).
 */
function ensureLocalDir(url: string): void {
  if (!url.startsWith('file:')) return;
  let file = url.slice('file:'.length);
  const query = file.indexOf('?');
  if (query !== -1) file = file.slice(0, query);
  if (!file || file === ':memory:' || file.endsWith(':memory:')) return;
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
  mkdirSync(abs.slice(0, Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/')) + 1) || '.', {
    recursive: true,
  });
}

ensureLocalDir(config.databaseUrl);

export const libsql = createClient({
  url: config.databaseUrl,
  ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}),
});

export const db = drizzle(libsql, { schema });

/** Apply committed migrations from server/drizzle/ (idempotent). */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
}

/** Test hook: wipe every table. */
export async function resetDatabaseForTests(): Promise<void> {
  await db.delete(schema.roomTable);
  await db.delete(schema.helperTokenTable);
  await db.delete(schema.sessionTable);
}