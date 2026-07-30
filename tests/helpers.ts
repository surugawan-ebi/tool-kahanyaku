import os from "node:os";
import { openTestDb } from "../src/db/client.js";
import { DEFAULT_CONFIG, type KahanyakuConfig } from "../src/config/config.js";
import type { AppContext } from "../src/core/context.js";
import type { Role, NoteStatus, Confidence } from "../src/types/common.js";

export function makeTestContext(overrides: Partial<AppContext> & { config?: Partial<KahanyakuConfig> } = {}): AppContext {
  const { config: configOverrides, ...rest } = overrides;
  return {
    db: openTestDb(),
    config: { ...DEFAULT_CONFIG, ...configOverrides },
    dataDir: os.tmpdir(),
    actor: "test-actor",
    role: "contributor" as Role,
    ...rest,
  };
}

export interface NoteFixture {
  id: string;
  slug?: string;
  title?: string;
  summary?: string;
  body?: string;
  status?: NoteStatus;
  confidence?: Confidence;
  scope?: string | null;
  owner?: string | null;
  version?: number;
  createdBy?: string;
  reviewDueAt?: string | null;
  tags?: string[];
}

/** Inserts a note row directly (bypassing the service layer) to set up review/verified/archived fixtures. */
export function insertNoteFixture(ctx: AppContext, fixture: NoteFixture): void {
  const now = new Date().toISOString();
  const status = fixture.status ?? "draft";
  ctx.db
    .prepare(
      `INSERT INTO notes
         (id, slug, title, summary, body, status, confidence, scope, owner, version,
          created_by, reviewed_by, created_at, updated_at, verified_at, archived_at,
          review_due_at, rejection_reason, draft_reason, search_text, metadata_json)
       VALUES
         (@id, @slug, @title, @summary, @body, @status, @confidence, @scope, @owner, @version,
          @created_by, NULL, @now, @now, @verified_at, @archived_at,
          @review_due_at, NULL, NULL, @search_text, '{}')`,
    )
    .run({
      id: fixture.id,
      slug: fixture.slug ?? fixture.id,
      title: fixture.title ?? "Fixture title",
      summary: fixture.summary ?? "Fixture summary",
      body: fixture.body ?? "# 概要\nFixture body",
      status,
      confidence: fixture.confidence ?? "medium",
      scope: fixture.scope ?? null,
      owner: fixture.owner ?? null,
      version: fixture.version ?? 1,
      created_by: fixture.createdBy ?? "test-actor",
      now,
      verified_at: status === "verified" || status === "archived" ? now : null,
      archived_at: status === "archived" ? now : null,
      review_due_at: fixture.reviewDueAt ?? null,
      search_text: `${fixture.title ?? ""} ${fixture.summary ?? ""}`.toLowerCase(),
    });
  for (const tag of fixture.tags ?? []) {
    ctx.db.prepare("INSERT INTO note_tags (note_id, tag) VALUES (?, ?)").run(fixture.id, tag);
  }
}
