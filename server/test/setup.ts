// Test isolation: every test process gets its own throwaway SQLite file, and the
// schema is migrated before any store/route module runs. Import this file FIRST
// in any test that touches rooms, sessions, or helper tokens.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbFile = join(tmpdir(), `golive-test-${process.pid}.db`);
try {
  rmSync(dbFile, { force: true });
} catch {
  // ignore
}
process.env.DATABASE_URL = `file:${dbFile}`;

const { runMigrations, resetDatabaseForTests } = await import('../src/db/client');
const { loadRooms } = await import('../src/store');
const { loadSessions } = await import('../src/sessions');
const { loadHelperTokens } = await import('../src/tokens');

await runMigrations();
await Promise.all([loadSessions(), loadHelperTokens(), loadRooms()]);

/** Wipe tables and rebuild the in-memory mirrors (for between-test resets). */
export async function resetAllForTests(): Promise<void> {
  await resetDatabaseForTests();
  await Promise.all([loadSessions(), loadHelperTokens(), loadRooms()]);
}