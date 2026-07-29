import type { CiteHankoDb } from "./client.js";

interface Migration {
  id: number;
  name: string;
  up(db: CiteHankoDb): void;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "001_init",
    up(db) {
      db.exec(`
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','verified','archived','rejected')),
          confidence TEXT NOT NULL DEFAULT 'medium'
            CHECK (confidence IN ('low','medium','high')),
          scope TEXT,
          owner TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          reviewed_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          verified_at TEXT,
          archived_at TEXT,
          review_due_at TEXT,
          rejection_reason TEXT,
          draft_reason TEXT,
          search_text TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
        );
        CREATE INDEX idx_notes_status ON notes(status);
        CREATE INDEX idx_notes_scope ON notes(scope);

        CREATE TABLE note_sources (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id),
          type TEXT NOT NULL CHECK (type IN ('manual','url','file','openwiki','github','other')),
          title TEXT, url TEXT, path TEXT, commit_sha TEXT, retrieved_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_note_sources_note ON note_sources(note_id);

        CREATE TABLE note_tags (
          note_id TEXT NOT NULL REFERENCES notes(id),
          tag TEXT NOT NULL,
          PRIMARY KEY (note_id, tag)
        );

        CREATE TABLE note_relations (
          note_id TEXT NOT NULL REFERENCES notes(id),
          related_note_id TEXT NOT NULL REFERENCES notes(id),
          relation_type TEXT NOT NULL DEFAULT 'related'
            CHECK (relation_type IN ('related','supersedes','conflicts_with','references')),
          PRIMARY KEY (note_id, related_note_id, relation_type)
        );

        CREATE TABLE update_proposals (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id),
          status TEXT NOT NULL DEFAULT 'pending_review'
            CHECK (status IN ('pending_review','approved','rejected','needs_rebase')),
          proposal_type TEXT NOT NULL DEFAULT 'update'
            CHECK (proposal_type IN ('update','archive_recommendation')),
          base_note_version INTEGER NOT NULL,
          proposed_title TEXT, proposed_summary TEXT, proposed_body TEXT,
          proposed_tags_json TEXT, proposed_scope TEXT,
          proposed_confidence TEXT CHECK (proposed_confidence IS NULL OR proposed_confidence IN ('low','medium','high')),
          diff TEXT NOT NULL,
          changed_fields_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          source_json TEXT NOT NULL DEFAULT '[]',
          proposed_by TEXT NOT NULL,
          reviewed_by TEXT,
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          rejection_reason TEXT
        );
        CREATE INDEX idx_proposals_note ON update_proposals(note_id);
        CREATE INDEX idx_proposals_status ON update_proposals(status);

        CREATE TABLE history_events (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('note','proposal','import','export')),
          entity_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL,
          role TEXT NOT NULL,
          scope TEXT,
          reason TEXT,
          before_snapshot_json TEXT,
          after_snapshot_json TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_history_entity ON history_events(entity_type, entity_id);

        CREATE TABLE import_batches (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('import','export')),
          path TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          summary_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE idempotency_keys (
          key TEXT NOT NULL,
          tool TEXT NOT NULL,
          actor TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
          result_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (key, tool, actor)
        );
      `);
    },
  },
  {
    id: 2,
    name: "002_fts5_search",
    up(db) {
      // FTS5 with the trigram tokenizer needs SQLite >= 3.34 built with FTS5 enabled.
      // Both are true for better-sqlite3's default prebuilt binaries (verified against the
      // version this project pins), but a differently-built native module should not be
      // able to break `citehanko init` entirely just because full-text search isn't
      // available -- LIKE-based search still works either way. So this step is best-effort:
      // wrapped in its own nested transaction (a SAVEPOINT, since we're already inside
      // runMigrations' transaction) so a failure partway through cleanly undoes any partial
      // DDL, and the outer try/catch swallows the error so the migration still "succeeds"
      // with notes_fts simply absent. search.ts's hasFts5TrigramSupport() probes for the
      // table's existence at search-engine construction time and falls back to (or, for
      // `search_engine: "fts5"` explicitly, throws a clear startup error instead of) LIKE.
      try {
        const createFts5 = db.transaction(() => {
          db.exec(`
            CREATE VIRTUAL TABLE notes_fts USING fts5(
              search_text,
              content='notes',
              content_rowid='rowid',
              tokenize='trigram'
            );

            CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
              INSERT INTO notes_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
            END;

            CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
              INSERT INTO notes_fts(notes_fts, rowid, search_text) VALUES('delete', old.rowid, old.search_text);
            END;

            CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
              INSERT INTO notes_fts(notes_fts, rowid, search_text) VALUES('delete', old.rowid, old.search_text);
              INSERT INTO notes_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
            END;

            INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
          `);
        });
        createFts5();
      } catch {
        // notes_fts stays absent; see comment above.
      }
    },
  },
];

/** Runs pending migrations in id order, each in its own transaction. */
export function runMigrations(db: CiteHankoDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedIds = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((row) => (row as { id: number }).id),
  );

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;
    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    applyMigration();
  }
}
