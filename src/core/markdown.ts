import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { AppContext } from "./context.js";
import { newId } from "./ids.js";
import { createHistoryService } from "./history.js";
import { createPolicyService } from "./policy.js";
import { createReviewService } from "./reviews.js";
import { changedFields } from "./diff.js";
import { buildSearchText } from "./searchText.js";
import { findPossibleDuplicates } from "./duplicates.js";
import { KahanyakuError } from "./errors.js";
import { computeConfigHash } from "../config/config.js";
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
  type NoteRow,
} from "./noteRows.js";
import { SourceType, type Confidence, type SourceInput } from "../types/common.js";
import type { Note, NoteWithDetail } from "../types/note.js";
import type { PolicyWarning } from "../types/policy.js";

export interface ExportedFileInfo {
  id: string;
  slug: string;
  status: string;
  path: string;
}

export interface ExportSummary {
  outDir: string;
  exported: number;
  files: ExportedFileInfo[];
}

interface FrontmatterSource {
  type: string;
  title?: string;
  url?: string;
  path?: string;
  commit_sha?: string;
  retrieved_at?: string;
}

function sourceToFrontmatter(s: NoteWithDetail["sources"][number]): FrontmatterSource {
  const fm: FrontmatterSource = { type: s.type };
  if (s.title) fm.title = s.title;
  if (s.url) fm.url = s.url;
  if (s.path) fm.path = s.path;
  if (s.commitSha) fm.commit_sha = s.commitSha;
  if (s.retrievedAt) fm.retrieved_at = s.retrievedAt;
  return fm;
}

/** Frontmatter shape from spec.md's Knowledge Note example, plus `version`. */
function buildFrontmatter(note: NoteWithDetail): Record<string, unknown> {
  return {
    id: note.id,
    title: note.title,
    slug: note.slug,
    type: "knowledge_note",
    status: note.status,
    confidence: note.confidence,
    scope: note.scope,
    owner: note.owner,
    created_by: note.createdBy,
    reviewed_by: note.reviewedBy,
    review_due_at: note.reviewDueAt,
    tags: note.tags,
    source: note.sources.map(sourceToFrontmatter),
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    verified_at: note.verifiedAt,
    archived_at: note.archivedAt,
    relations: note.relations.map((r) => r.relatedNoteId),
    summary: note.summary,
    version: note.version,
  };
}

/**
 * Writes every non-rejected note to `<outDir>/<slug>--<note_id>.md`, wiping
 * stale .md files first (export overwrites the directory contents each run).
 */
export function exportAll(ctx: AppContext, outDir: string): ExportSummary {
  const { db, actor, role } = ctx;
  const history = createHistoryService(ctx);

  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(outDir)) {
    if (entry.endsWith(".md")) fs.unlinkSync(path.join(outDir, entry));
  }

  const rows = db.prepare("SELECT * FROM notes WHERE status != 'rejected' ORDER BY slug").all() as NoteRow[];
  const files: ExportedFileInfo[] = rows.map((row) => {
    const detail = toDetail(db, rowToNote(row));
    const frontmatter = buildFrontmatter(detail);
    const fileContent = matter.stringify(detail.body, frontmatter);
    const fileName = `${detail.slug}--${detail.id}.md`;
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, fileContent, "utf-8");
    return { id: detail.id, slug: detail.slug, status: detail.status, path: filePath };
  });

  const summary: ExportSummary = { outDir, exported: files.length, files };

  const batchId = newId("batch");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO import_batches (id, type, path, actor, created_at, summary_json) VALUES (?, 'export', ?, ?, ?, ?)",
  ).run(batchId, outDir, actor, now, JSON.stringify(summary));

  history.record({
    entityType: "export",
    entityId: batchId,
    eventType: "note_exported",
    actor,
    role,
    afterSnapshot: { summary },
  });

  return summary;
}

export interface ImportOptions {
  /** Human-only: attempt to verify new drafts immediately, subject to required_fields_for_verify. */
  verified?: boolean;
  /** Fallback source type for frontmatter that has no `source` list. */
  sourceType?: import("../types/common.js").SourceType;
  commitSha?: string;
}

export interface ImportWarning {
  file: string;
  message: string;
}

export interface ImportSummary {
  createdDrafts: number;
  updatedDrafts: number;
  proposals: number;
  skipped: number;
  warnings: ImportWarning[];
  createdIds: string[];
  proposalIds: string[];
}

function collectMarkdownFiles(inputPath: string): string[] {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return inputPath.endsWith(".md") ? [inputPath] : [];
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) results.push(full);
    }
  };
  walk(inputPath);
  return results.sort();
}

function normalizeFrontmatterSources(fmSource: unknown, opts: ImportOptions): SourceInput[] {
  if (Array.isArray(fmSource) && fmSource.length > 0) {
    return fmSource.map((entry) => {
      const obj = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const parsedType = SourceType.safeParse(obj.type);
      return {
        type: parsedType.success ? parsedType.data : (opts.sourceType ?? "file"),
        title: typeof obj.title === "string" ? obj.title : null,
        url: typeof obj.url === "string" ? obj.url : null,
        path: typeof obj.path === "string" ? obj.path : null,
        commit_sha: typeof obj.commit_sha === "string" ? obj.commit_sha : (opts.commitSha ?? null),
        retrieved_at: typeof obj.retrieved_at === "string" ? obj.retrieved_at : null,
      };
    });
  }
  if (opts.sourceType) {
    return [{ type: opts.sourceType, title: null, url: null, path: null, commit_sha: opts.commitSha ?? null, retrieved_at: null }];
  }
  return [];
}

/**
 * Fields absent from frontmatter are `undefined` (not defaulted) so downstream
 * code can tell "not specified in this file" apart from "explicitly cleared"
 * (`null`, only meaningful for scope/owner) or "explicitly set to a value".
 * This matters for two reasons: (1) update_draft-style partial re-import must
 * not silently wipe fields (e.g. sources) that a hand-edited file just didn't
 * repeat, and (2) changedFields()/createProposal must not read an omitted
 * field as "changed to empty string", which previously crashed proposed_summary
 * validation (zod .min(1)) on any verified-note re-import missing `summary`.
 */
interface ParsedFields {
  id: string | null;
  title?: string;
  summary?: string;
  body: string;
  tags?: string[];
  scope?: string | null;
  owner?: string | null;
  confidence?: Confidence;
  source?: SourceInput[];
  slugHint?: string;
}

function parseFrontmatter(file: string, opts: ImportOptions): ParsedFields {
  const raw = fs.readFileSync(file, "utf-8");
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const confidenceCandidate = fm.confidence;
  const confidence: Confidence | undefined =
    confidenceCandidate === "low" || confidenceCandidate === "medium" || confidenceCandidate === "high"
      ? confidenceCandidate
      : undefined;
  return {
    id: typeof fm.id === "string" ? fm.id : null,
    title: typeof fm.title === "string" && fm.title.length > 0 ? fm.title : undefined,
    summary: typeof fm.summary === "string" ? fm.summary : undefined,
    body: parsed.content.trim(),
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
    scope: "scope" in fm ? (typeof fm.scope === "string" ? fm.scope : null) : undefined,
    owner: "owner" in fm ? (typeof fm.owner === "string" ? fm.owner : null) : undefined,
    confidence,
    source: "source" in fm ? normalizeFrontmatterSources(fm.source, opts) : undefined,
    slugHint: typeof fm.slug === "string" ? fm.slug : undefined,
  };
}

/**
 * Imports Markdown files (a single file or a directory, walked recursively)
 * as drafts, draft updates, or update proposals, per detailed-design.md's
 * import rules. Never throws for a single bad file -- failures are recorded
 * as warnings and counted as skipped so the whole batch can still complete.
 */
export function importPath(ctx: AppContext, inputPath: string, opts: ImportOptions = {}): ImportSummary {
  const { db, actor, role, config } = ctx;
  const history = createHistoryService(ctx);
  const policy = createPolicyService(ctx);
  const reviews = createReviewService(ctx);

  const summary: ImportSummary = {
    createdDrafts: 0,
    updatedDrafts: 0,
    proposals: 0,
    skipped: 0,
    warnings: [],
    createdIds: [],
    proposalIds: [],
  };

  function tryVerifyImportedDraft(noteId: string): { verified: boolean; reason?: string; warnings?: PolicyWarning[] } {
    const note = getNoteRow(db, noteId);
    if (!note) return { verified: false, reason: "note disappeared during import" };
    const sources = getSources(db, noteId).map((s) => ({ type: s.type }));
    const required = new Set(config.required_fields_for_verify);
    const missing: string[] = [];
    if (required.has("source") && sources.length === 0) missing.push("source");
    if (required.has("owner") && !note.owner) missing.push("owner");
    if (missing.length > 0) {
      return { verified: false, reason: `missing required field(s): ${missing.join(", ")}` };
    }

    // required_fields_for_verify passed; still run the full approve-time policy check (the
    // same one a human `kahanyaku approve` would trigger) so e.g. reviewer_separation --
    // always true here, since the importer is necessarily also created_by for a brand-new
    // note -- surfaces in the import summary instead of silently skipping it.
    const approveWarnings = policy.checkApprove({
      kind: "note",
      authorActor: note.created_by,
      confidence: note.confidence as Confidence,
      owner: note.owner,
      sources,
      scope: note.scope,
    });

    // Same enforce-mode authorization as a human `kahanyaku approve` would apply. Unlike
    // that path, a rejection here doesn't abort the whole import -- it's downgraded to the
    // same "created as draft, could not verify" outcome as a missing required field, so one
    // note's policy violation doesn't stop the rest of the batch.
    let scopeReviewerBypass = false;
    try {
      scopeReviewerBypass = policy.assertApprovalAuthorized({ authorActor: note.created_by, scope: note.scope }).scopeReviewerBypass;
    } catch (err) {
      if (err instanceof KahanyakuError) {
        return { verified: false, reason: err.message };
      }
      throw err;
    }

    const now = new Date().toISOString();
    const configHash = computeConfigHash(config);
    const runVerify = db.transaction(() => {
      const beforeSnapshot = buildNoteSnapshot(db, note);
      const reviewDueAt = policy.computeReviewDueAt(now);
      const updated: NoteRow = {
        ...note,
        status: "verified",
        verified_at: now,
        review_due_at: reviewDueAt,
        reviewed_by: actor,
        updated_at: now,
      };
      db.prepare(
        `UPDATE notes SET status=@status, verified_at=@verified_at, review_due_at=@review_due_at,
           reviewed_by=@reviewed_by, updated_at=@updated_at WHERE id=@id`,
      ).run(updated);
      history.record({
        entityType: "note",
        entityId: noteId,
        eventType: "note_verified",
        actor,
        role,
        scope: note.scope,
        reason: "verified on import (--verified)",
        beforeSnapshot,
        afterSnapshot: buildNoteSnapshot(db, updated),
        metadata: scopeReviewerBypass ? { config_hash: configHash, scope_reviewer_bypass: true } : { config_hash: configHash },
      });
    });
    runVerify();

    return { verified: true, warnings: approveWarnings.length > 0 ? approveWarnings : undefined };
  }

  function insertNewNote(explicitId: string | undefined, fields: ParsedFields, file: string): { note: Note; policyWarnings: PolicyWarning[] } {
    const now = new Date().toISOString();
    const id = explicitId ?? newId("note");
    const title = fields.title ?? path.basename(file, ".md");
    const summaryText = fields.summary ?? "";
    const tags = fields.tags ?? [];
    const scope = fields.scope ?? null;
    const owner = fields.owner ?? null;
    const confidence = fields.confidence ?? "medium";
    const source = fields.source ?? [];

    const { slug } = resolveUniqueSlug(db, slugify(fields.slugHint ?? title));
    const searchText = buildSearchText(title, summaryText, fields.body, tags);
    const policyWarnings = policy.checkDraft({ summary: summaryText, body: fields.body, tags, confidence, sources: source });
    const possibleDuplicates = findPossibleDuplicates(ctx, title, summaryText);

    const row: NoteRow = {
      id,
      slug,
      title,
      summary: summaryText,
      body: fields.body,
      status: "draft",
      confidence,
      scope,
      owner,
      version: 1,
      created_by: actor,
      reviewed_by: null,
      created_at: now,
      updated_at: now,
      verified_at: null,
      archived_at: null,
      review_due_at: null,
      rejection_reason: null,
      draft_reason: source.length === 0 ? `imported from ${file}` : null,
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
    replaceTags(db, id, tags);
    replaceSources(db, id, source);
    history.record({
      entityType: "note",
      entityId: id,
      eventType: "note_created",
      actor,
      role,
      scope,
      reason: `imported from ${file}`,
      afterSnapshot: buildNoteSnapshot(db, row),
    });
    return { note: rowToNote(row), policyWarnings };
  }

  function updateExistingDraft(existing: NoteRow, fields: ParsedFields): PolicyWarning[] {
    // Captured before any mutation below, for the history beforeSnapshot.
    const beforeSnapshot = buildNoteSnapshot(db, existing);
    // Fields omitted from frontmatter keep the draft's current value (a partial
    // hand-edit shouldn't silently blank out title/summary/tags/sources/etc).
    const title = fields.title ?? existing.title;
    const summaryText = fields.summary ?? existing.summary;
    const tags = fields.tags ?? getTags(db, existing.id);
    const scope = fields.scope !== undefined ? fields.scope : existing.scope;
    const owner = fields.owner !== undefined ? fields.owner : existing.owner;
    const confidence = fields.confidence ?? (existing.confidence as Confidence);
    const source: SourceInput[] =
      fields.source ??
      getSources(db, existing.id).map((s) => ({
        type: s.type,
        title: s.title,
        url: s.url,
        path: s.path,
        commit_sha: s.commitSha,
        retrieved_at: s.retrievedAt,
      }));

    const now = new Date().toISOString();
    const searchText = buildSearchText(title, summaryText, fields.body, tags);
    const updated: NoteRow = {
      ...existing,
      title,
      summary: summaryText,
      body: fields.body,
      confidence,
      scope,
      owner,
      version: existing.version + 1,
      updated_at: now,
      search_text: searchText,
    };
    db.prepare(
      `UPDATE notes SET title=@title, summary=@summary, body=@body, confidence=@confidence,
         scope=@scope, owner=@owner, version=@version, updated_at=@updated_at, search_text=@search_text
       WHERE id=@id`,
    ).run(updated);
    replaceTags(db, existing.id, tags);
    replaceSources(db, existing.id, source);
    const policyWarnings = policy.checkDraft({ summary: summaryText, body: fields.body, tags, confidence, sources: source });
    history.record({
      entityType: "note",
      entityId: existing.id,
      eventType: "note_updated",
      actor,
      role,
      scope,
      reason: "imported from markdown",
      beforeSnapshot,
      afterSnapshot: buildNoteSnapshot(db, updated),
    });
    return policyWarnings;
  }

  function processOneFile(file: string): void {
    const fields = parseFrontmatter(file, opts);
    const existing = fields.id ? getNoteRow(db, fields.id) : undefined;

    if (!existing) {
      const { note, policyWarnings } = insertNewNote(fields.id ?? undefined, fields, file);
      summary.createdDrafts += 1;
      summary.createdIds.push(note.id);
      if (policyWarnings.length > 0) {
        summary.warnings.push({ file, message: `policy warnings: ${policyWarnings.map((w) => w.code).join(", ")}` });
      }
      if (opts.verified) {
        const outcome = tryVerifyImportedDraft(note.id);
        if (!outcome.verified) {
          summary.warnings.push({ file, message: `created as draft (could not verify: ${outcome.reason})` });
        } else if (outcome.warnings && outcome.warnings.length > 0) {
          summary.warnings.push({
            file,
            message: `verified with policy warnings: ${outcome.warnings.map((w) => w.code).join(", ")}`,
          });
        }
      }
      return;
    }

    if (existing.status === "draft") {
      const policyWarnings = updateExistingDraft(existing, fields);
      summary.updatedDrafts += 1;
      if (policyWarnings.length > 0) {
        summary.warnings.push({ file, message: `policy warnings: ${policyWarnings.map((w) => w.code).join(", ")}` });
      }
      return;
    }

    if (existing.status === "verified") {
      const currentTags = getTags(db, existing.id);
      const changed = changedFields(
        { title: fields.title, summary: fields.summary, body: fields.body, tags: fields.tags, scope: fields.scope, confidence: fields.confidence },
        { title: existing.title, summary: existing.summary, body: existing.body, tags: currentTags, scope: existing.scope, confidence: existing.confidence },
      );
      if (changed.length === 0) {
        summary.skipped += 1;
        summary.warnings.push({ file, message: `note ${existing.id} unchanged from current verified note; skipped` });
        return;
      }
      const { proposal } = reviews.createProposal({
        id: existing.id,
        base_note_version: existing.version,
        proposed_title: changed.includes("title") ? fields.title : null,
        proposed_summary: changed.includes("summary") ? fields.summary : null,
        proposed_body: changed.includes("body") ? fields.body : null,
        proposed_tags: changed.includes("tags") ? fields.tags : null,
        proposed_scope: changed.includes("scope") ? fields.scope : null,
        proposed_confidence: changed.includes("confidence") ? fields.confidence : null,
        reason: `imported from ${file}`,
        source: fields.source ?? [],
      });
      summary.proposals += 1;
      summary.proposalIds.push(proposal.id);
      return;
    }

    // archived / rejected: spec.md says skip + warn, never abort the batch.
    summary.skipped += 1;
    summary.warnings.push({ file, message: `note ${existing.id} is ${existing.status}; import skipped` });
  }

  const files = collectMarkdownFiles(inputPath);
  for (const file of files) {
    try {
      processOneFile(file);
    } catch (err) {
      summary.skipped += 1;
      summary.warnings.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const batchId = newId("batch");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO import_batches (id, type, path, actor, created_at, summary_json) VALUES (?, 'import', ?, ?, ?, ?)",
  ).run(batchId, inputPath, actor, now, JSON.stringify(summary));

  history.record({
    entityType: "import",
    entityId: batchId,
    eventType: "note_imported",
    actor,
    role,
    afterSnapshot: { summary },
  });

  return summary;
}
