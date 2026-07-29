import type { AppContext } from "./context.js";
import { newId } from "./ids.js";
import { CiteHankoError, parseOrThrow } from "./errors.js";
import { createHistoryService } from "./history.js";
import { createPolicyService } from "./policy.js";
import { computeConfigHash } from "../config/config.js";
import { findPossibleDuplicates } from "./duplicates.js";
import { buildSearchText } from "./searchText.js";
import {
  getNoteRow,
  getTags,
  getSources,
  toDetail,
  replaceTags,
  replaceSources,
  buildNoteSnapshot,
  slugify,
  resolveUniqueSlug,
  rowToNote,
  isStale,
  type NoteRow,
} from "./noteRows.js";
import {
  CreateDraftInput,
  UpdateDraftInput,
  type Note,
  type NoteWithDetail,
  type NoteSummary,
  type NoteListFilter,
  type CreateDraftResult,
  type UpdateDraftResult,
} from "../types/note.js";
import type { SourceInput } from "../types/common.js";

export interface NoteService {
  createDraft(input: CreateDraftInput): CreateDraftResult;
  updateDraft(input: UpdateDraftInput): UpdateDraftResult;
  getVerifiedNote(id: string): NoteWithDetail;
  getNoteForReview(id: string): NoteWithDetail;
  archiveNote(id: string, reason: string): Note;
  listNotes(filter: NoteListFilter): NoteSummary[];
}

export function createNoteService(ctx: AppContext): NoteService {
  const { db, actor, role, config } = ctx;
  const history = createHistoryService(ctx);
  const policy = createPolicyService(ctx);

  function requireNote(id: string): NoteRow {
    const row = getNoteRow(db, id);
    if (!row) {
      throw new CiteHankoError("not_found", `${id} was not found`, { details: { id } });
    }
    return row;
  }

  return {
    createDraft(rawInput: CreateDraftInput): CreateDraftResult {
      const input = parseOrThrow(CreateDraftInput, rawInput);

      if (input.source.length === 0 && !input.reason) {
        throw new CiteHankoError(
          "invalid_input",
          "either source[] or reason is required to create a draft",
          { suggested_action: "provide at least one source or a reason for this note" },
        );
      }

      const now = new Date().toISOString();
      const id = newId("note");
      const { slug, adjusted } = resolveUniqueSlug(db, slugify(input.title));
      const searchText = buildSearchText(input.title, input.summary, input.body, input.tags);
      const policyWarnings = policy.checkDraft({
        summary: input.summary,
        body: input.body,
        tags: input.tags,
        confidence: input.confidence,
        sources: input.source,
      });
      const possibleDuplicates = findPossibleDuplicates(ctx, input.title, input.summary);

      const runCreate = db.transaction(() => {
        const row: NoteRow = {
          id,
          slug,
          title: input.title,
          summary: input.summary,
          body: input.body,
          status: "draft",
          confidence: input.confidence,
          scope: input.scope ?? null,
          owner: input.owner ?? null,
          version: 1,
          created_by: actor,
          reviewed_by: null,
          created_at: now,
          updated_at: now,
          verified_at: null,
          archived_at: null,
          review_due_at: null,
          rejection_reason: null,
          draft_reason: input.reason ?? null,
          search_text: searchText,
          metadata_json: JSON.stringify({ possible_duplicates: possibleDuplicates }),
        };
        db.prepare(
          `INSERT INTO notes
             (id, slug, title, summary, body, status, confidence, scope, owner, version,
              created_by, reviewed_by, created_at, updated_at, verified_at, archived_at,
              review_due_at, rejection_reason, draft_reason, search_text, metadata_json)
           VALUES
             (@id, @slug, @title, @summary, @body, @status, @confidence, @scope, @owner, @version,
              @created_by, @reviewed_by, @created_at, @updated_at, @verified_at, @archived_at,
              @review_due_at, @rejection_reason, @draft_reason, @search_text, @metadata_json)`,
        ).run(row);
        replaceTags(db, id, input.tags);
        replaceSources(db, id, input.source);

        history.record({
          entityType: "note",
          entityId: id,
          eventType: "note_created",
          actor,
          role,
          scope: input.scope ?? null,
          reason: input.reason ?? null,
          afterSnapshot: buildNoteSnapshot(db, row),
        });

        return rowToNote(row);
      });

      const note = runCreate();
      return { note, policyWarnings, possibleDuplicates, slugAdjusted: adjusted };
    },

    updateDraft(rawInput: UpdateDraftInput): UpdateDraftResult {
      const input = parseOrThrow(UpdateDraftInput, rawInput);
      const before = requireNote(input.id);

      if (before.status === "archived") {
        throw new CiteHankoError("archived_target", `${input.id} is archived and cannot be edited`, {
          details: { status: before.status },
        });
      }
      if (before.status === "verified") {
        throw new CiteHankoError(
          "invalid_input",
          `${input.id} is verified; use propose_note_update instead`,
          { details: { status: before.status }, suggested_action: "use propose_note_update" },
        );
      }
      if (before.created_by !== actor) {
        throw new CiteHankoError("not_draft_owner", `${actor} does not own draft ${input.id}`, {
          details: { owner: before.created_by },
        });
      }

      const resubmitted = before.status === "rejected";
      const beforeTags = getTags(db, before.id);
      const title = input.title ?? before.title;
      const summary = input.summary ?? before.summary;
      const body = input.body ?? before.body;
      const tags = input.tags ?? beforeTags;
      const sources = input.source ?? undefined;
      const confidence = input.confidence ?? before.confidence;
      const scope = input.scope ?? before.scope;
      const owner = input.owner ?? before.owner;
      const now = new Date().toISOString();
      const searchText = buildSearchText(title, summary, body, tags);

      const effectiveSources: SourceInput[] = sources ?? getSources(db, before.id).map((s) => ({
        type: s.type,
        title: s.title,
        url: s.url,
        path: s.path,
        commit_sha: s.commitSha,
        retrieved_at: s.retrievedAt,
      }));

      const policyWarnings = policy.checkDraft({
        summary,
        body,
        tags,
        confidence: confidence as Note["confidence"],
        sources: effectiveSources,
      });

      const runUpdate = db.transaction(() => {
        const beforeSnapshot = buildNoteSnapshot(db, before);
        const updated: NoteRow = {
          ...before,
          title,
          summary,
          body,
          status: "draft",
          confidence,
          scope,
          owner,
          version: before.version + 1,
          updated_at: now,
          draft_reason: input.reason ?? before.draft_reason,
          search_text: searchText,
        };
        db.prepare(
          `UPDATE notes SET
             title=@title, summary=@summary, body=@body, status=@status, confidence=@confidence,
             scope=@scope, owner=@owner, version=@version, updated_at=@updated_at,
             draft_reason=@draft_reason, search_text=@search_text
           WHERE id=@id`,
        ).run(updated);
        if (input.tags) replaceTags(db, before.id, input.tags);
        if (sources) replaceSources(db, before.id, sources);

        history.record({
          entityType: "note",
          entityId: before.id,
          eventType: resubmitted ? "note_resubmitted" : "note_updated",
          actor,
          role,
          scope,
          reason: input.reason ?? null,
          beforeSnapshot,
          afterSnapshot: buildNoteSnapshot(db, updated),
        });

        return rowToNote(updated);
      });

      const note = runUpdate();
      return { note, resubmitted, policyWarnings };
    },

    getVerifiedNote(id: string): NoteWithDetail {
      const row = requireNote(id);
      if (row.status !== "verified" && row.status !== "archived") {
        throw new CiteHankoError("not_verified", `${id} is ${row.status}, not verified.`, {
          details: { status: row.status },
          suggested_action: "use get_review_item",
        });
      }
      return toDetail(db, rowToNote(row));
    },

    getNoteForReview(id: string): NoteWithDetail {
      const row = requireNote(id);
      return toDetail(db, rowToNote(row));
    },

    archiveNote(id: string, reason: string): Note {
      const before = requireNote(id);
      if (before.status === "archived") {
        throw new CiteHankoError("archived_target", `${id} is already archived`);
      }
      if (before.status !== "verified") {
        throw new CiteHankoError("invalid_input", `${id} must be verified before it can be archived`, {
          details: { status: before.status },
        });
      }

      const now = new Date().toISOString();
      const configHash = computeConfigHash(config);
      const runArchive = db.transaction(() => {
        const beforeSnapshot = buildNoteSnapshot(db, before);
        const updated: NoteRow = { ...before, status: "archived", archived_at: now, updated_at: now };
        db.prepare("UPDATE notes SET status=@status, archived_at=@archived_at, updated_at=@updated_at WHERE id=@id").run(
          updated,
        );
        history.record({
          entityType: "note",
          entityId: id,
          eventType: "note_archived",
          actor,
          role,
          scope: before.scope,
          reason,
          beforeSnapshot,
          afterSnapshot: buildNoteSnapshot(db, updated),
          metadata: { config_hash: configHash },
        });
        return rowToNote(updated);
      });

      return runArchive();
    },

    listNotes(filter: NoteListFilter): NoteSummary[] {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.status) {
        clauses.push("status = @status");
        params.status = filter.status;
      }
      if (filter.scope) {
        clauses.push("scope = @scope");
        params.scope = filter.scope;
      }
      if (filter.createdBy) {
        clauses.push("created_by = @createdBy");
        params.createdBy = filter.createdBy;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = filter.limit ?? 100;
      const rows = db
        .prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC LIMIT @limit`)
        .all({ ...params, limit }) as NoteRow[];

      return rows.map((row) => {
        const note = rowToNote(row);
        return {
          id: note.id,
          slug: note.slug,
          title: note.title,
          summary: note.summary,
          status: note.status,
          confidence: note.confidence,
          scope: note.scope,
          owner: note.owner,
          tags: getTags(db, note.id),
          updatedAt: note.updatedAt,
          reviewDueAt: note.reviewDueAt,
          stale: isStale(note),
        };
      });
    },
  };
}
