import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema (Drizzle). Works against a local `file:` database during
 * development/tests and a remote Turso database (`libsql://`) in production —
 * same tables, same queries.
 *
 * Timestamps are stored as epoch milliseconds (`timestamp_ms` mode).
 */

export const sessionTable = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull(),
  username: text('username').notNull(),
  avatar: text('avatar'),
  createdAt: integer('created_at').notNull(),
  /** Server-side expiry; enforced on every read (default 30 days). */
  expiresAt: integer('expires_at').notNull(),
});

export const helperTokenTable = sqliteTable('helper_tokens', {
  /** SHA-256 of the raw bearer token — the raw token is never stored. */
  tokenHash: text('token_hash').primaryKey(),
  /** Public device id shown in the host UI. */
  id: text('id').notNull(),
  userId: text('user_id').notNull(),
  username: text('username').notNull(),
  avatar: text('avatar'),
  deviceName: text('device_name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const roomTable = sqliteTable('rooms', {
  roomId: text('room_id').primaryKey(),
  hostId: text('host_id').notNull(),
  hostName: text('host_name').notNull(),
  createdAt: integer('created_at').notNull(),
  /** Watch link stops working after this instant (lazy + periodic sweep). */
  expiresAt: integer('expires_at').notNull(),
  turnUrls: text('turn_urls'),
  turnUsername: text('turn_username'),
  turnCredential: text('turn_credential'),
});