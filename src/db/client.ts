import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type KahanyakuDb = Database.Database;

export interface OpenDbOptions {
  /** Skip running migrations (tests that need a raw handle before migration). */
  skipMigrations?: boolean;
}

/**
 * Opens the SQLite database at `<dataDir>/kahanyaku.sqlite`, applying the
 * pragmas the storage design requires (WAL, busy_timeout, foreign_keys) and
 * running pending migrations.
 */
export function openDb(dataDir: string, options: OpenDbOptions = {}): KahanyakuDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "kahanyaku.sqlite");
  const db = new Database(dbPath);
  applyPragmas(db);
  if (!options.skipMigrations) {
    runMigrations(db);
  }
  return db;
}

/** Opens an in-memory database (tests only). Migrations still run by default. */
export function openTestDb(options: OpenDbOptions = {}): KahanyakuDb {
  const db = new Database(":memory:");
  applyPragmas(db);
  if (!options.skipMigrations) {
    runMigrations(db);
  }
  return db;
}

function applyPragmas(db: KahanyakuDb): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}
