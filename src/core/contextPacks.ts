import type { AppContext } from "./context.js";
import type { ContextPackConfig } from "../config/config.js";
import { KahanyakuError } from "./errors.js";
import { getNoteRow, getTags, isStale, type NoteRow } from "./noteRows.js";
import { buildCitation, type Citation } from "./citation.js";
import type { Confidence, NoteStatus } from "../types/common.js";

// Metadata-only responses can afford a bigger default page than include_body:true ones,
// which carry full note bodies -- see config.ts's max_body_chars and detailed-design.md.
const DEFAULT_LIMIT_METADATA_ONLY = 50;
const DEFAULT_LIMIT_WITH_BODY = 20;

export type ContextPackExclusionReason = "archived" | "not_verified" | "stale_filtered" | "not_found";

export interface ContextPackExclusion {
  id: string;
  reason: ContextPackExclusionReason;
}

export interface ContextPackNoteEntry {
  id: string;
  title: string;
  summary: string;
  scope: string | null;
  tags: string[];
  confidence: Confidence;
  updatedAt: string;
  reviewDueAt: string | null;
  stale: boolean;
  citation: Citation;
  /** Only present when include_body was requested. */
  body?: string;
  bodyTruncated?: boolean;
}

export interface ContextPackResult {
  name: string;
  description: string;
  notes: ContextPackNoteEntry[];
  excluded: ContextPackExclusion[];
  truncated: boolean;
  nextCursor: string | null;
  /** Pack-level notices, e.g. "N stale notes included" when strict_stale_filter is off. */
  warnings: string[];
}

export interface ContextPackSummary {
  name: string;
  description: string;
  noteCount: number;
}

export interface GetContextPackOptions {
  includeBody?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface ContextPackService {
  listPacks(): ContextPackSummary[];
  getPack(name: string, opts?: GetContextPackOptions): ContextPackResult;
}

/**
 * Resolves a pack's selector to the notes it currently matches, already split into
 * included (verified, and not stale-filtered) vs excluded (with a reason). Selector
 * semantics (see config.ts's ContextPackConfig doc comment): membership is
 * (note.scope is one of `scopes` OR'd together, AND note has every tag in `tags`) UNION
 * (note.id is explicitly pinned in `note_ids`). An empty `scopes` contributes nothing via
 * the scope/tag path (only pins apply); an empty `tags` is vacuously satisfied by every
 * note. The scope/tag path only ever queries status='verified' rows, so archived (or
 * draft/rejected) notes can only enter the candidate set via an explicit pin -- and even
 * then, archived notes are always excluded, never distributed.
 */
function resolveCandidates(
  ctx: AppContext,
  pack: ContextPackConfig,
): { included: NoteRow[]; excluded: ContextPackExclusion[] } {
  const { db, config } = ctx;
  const byId = new Map<string, NoteRow>();

  if (pack.scopes.length > 0) {
    const clauses = [`status = 'verified'`, `scope IN (${pack.scopes.map(() => "?").join(",")})`];
    const params: unknown[] = [...pack.scopes];
    for (const tag of pack.tags) {
      clauses.push("EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.id AND nt.tag = ?)");
      params.push(tag);
    }
    const rows = db.prepare(`SELECT * FROM notes WHERE ${clauses.join(" AND ")}`).all(...params) as NoteRow[];
    for (const row of rows) byId.set(row.id, row);
  }

  const excluded: ContextPackExclusion[] = [];
  for (const id of pack.note_ids) {
    if (byId.has(id)) continue; // already matched via the scope/tag path
    const row = getNoteRow(db, id);
    if (!row) {
      excluded.push({ id, reason: "not_found" });
      continue;
    }
    byId.set(row.id, row);
  }

  const included: NoteRow[] = [];
  for (const row of byId.values()) {
    if (row.status === "archived") {
      excluded.push({ id: row.id, reason: "archived" });
      continue;
    }
    if (row.status !== "verified") {
      // Only reachable via an explicit pin -- the scope/tag path is verified-only already.
      excluded.push({ id: row.id, reason: "not_verified" });
      continue;
    }
    if (isStale({ status: row.status as NoteStatus, reviewDueAt: row.review_due_at }) && config.strict_stale_filter) {
      excluded.push({ id: row.id, reason: "stale_filtered" });
      continue;
    }
    included.push(row);
  }

  excluded.sort((a, b) => a.id.localeCompare(b.id));
  return { included, excluded };
}

function buildNoteEntry(ctx: AppContext, row: NoteRow, includeBody: boolean): ContextPackNoteEntry {
  const { db, config } = ctx;
  const tags = getTags(db, row.id);
  const stale = isStale({ status: row.status as NoteStatus, reviewDueAt: row.review_due_at });
  const citation = buildCitation({
    id: row.id,
    title: row.title,
    version: row.version,
    updatedAt: row.updated_at,
    reviewDueAt: row.review_due_at,
    stale,
    confidence: row.confidence as Confidence,
    status: row.status as NoteStatus,
    scope: row.scope,
  });

  const entry: ContextPackNoteEntry = {
    id: row.id,
    title: row.title,
    summary: row.summary,
    scope: row.scope,
    tags,
    confidence: row.confidence as Confidence,
    updatedAt: row.updated_at,
    reviewDueAt: row.review_due_at,
    stale,
    citation,
  };

  if (includeBody) {
    const truncated = row.body.length > config.max_body_chars;
    entry.body = truncated ? row.body.slice(0, config.max_body_chars) : row.body;
    entry.bodyTruncated = truncated;
  }

  return entry;
}

export function createContextPackService(ctx: AppContext): ContextPackService {
  const { config } = ctx;

  return {
    listPacks(): ContextPackSummary[] {
      return Object.entries(config.context_packs).map(([name, pack]) => {
        const { included } = resolveCandidates(ctx, pack);
        return { name, description: pack.description, noteCount: included.length };
      });
    },

    getPack(name: string, opts: GetContextPackOptions = {}): ContextPackResult {
      const pack = config.context_packs[name];
      if (!pack) {
        const available = Object.keys(config.context_packs);
        throw new KahanyakuError("not_found", `context pack "${name}" was not found`, {
          details: { name },
          suggested_action:
            available.length > 0
              ? `available context packs: ${available.join(", ")}`
              : "no context packs are configured; add one under context_packs in kahanyaku.config.yaml",
        });
      }

      const { included, excluded } = resolveCandidates(ctx, pack);
      const includeBody = opts.includeBody ?? false;
      const limit = opts.limit ?? (includeBody ? DEFAULT_LIMIT_WITH_BODY : DEFAULT_LIMIT_METADATA_ONLY);

      // Most-recently-updated first, id as a stable tie-break.
      const sorted = [...included].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
      let page = sorted;
      if (opts.cursor) {
        const idx = page.findIndex((r) => r.id === opts.cursor);
        if (idx >= 0) page = page.slice(idx + 1);
      }
      const sliced = page.slice(0, limit);
      // Same simplified "did we hit the page size" signal as listReviewItems: not a precise
      // "is there really more" check, just "the page filled up to limit".
      const nextCursor = sliced.length === limit && sliced.length > 0 ? sliced[sliced.length - 1].id : null;

      const staleCount = included.filter((r) => isStale({ status: r.status as NoteStatus, reviewDueAt: r.review_due_at })).length;
      const warnings: string[] =
        staleCount > 0 && !config.strict_stale_filter
          ? [`${staleCount} note(s) in this pack are stale (past review_due_at); confirm before relying on them.`]
          : [];

      return {
        name,
        description: pack.description,
        notes: sliced.map((row) => buildNoteEntry(ctx, row, includeBody)),
        excluded,
        truncated: nextCursor !== null,
        nextCursor,
        warnings,
      };
    },
  };
}
