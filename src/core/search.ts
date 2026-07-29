import type { AppContext } from "./context.js";
import type { CiteHankoDb } from "../db/client.js";
import { getTags, isStale, type NoteRow } from "./noteRows.js";
import { normalizeForSearch } from "./searchText.js";
import { buildCitation, type Citation } from "./citation.js";
import { CiteHankoError } from "./errors.js";
import type { Confidence, NoteStatus } from "../types/common.js";

const SNIPPET_RADIUS = 60;
const DEFAULT_LIMIT = 10;
// A trigram is exactly 3 characters; the trigram tokenizer structurally cannot match a
// query shorter than that (empirically verified: MATCH '返金' on a trigram index returns
// nothing even though the indexed text contains it, while MATCH '返金ポ' finds it).
const FTS5_MIN_TERM_LENGTH = 3;

export interface SearchInput {
  query: string;
  tags?: string[];
  /** Not in spec.md's minimal search_notes example, but the 0-results example echoes a "scope" field back;
   *  treated here as an optional filter that doubles as that echo value. */
  scope?: string | null;
  include_archived?: boolean;
  limit?: number;
}

export interface SearchResultItem {
  id: string;
  title: string;
  summary: string;
  status: NoteStatus;
  confidence: Confidence;
  scope: string | null;
  owner: string | null;
  updatedAt: string;
  reviewDueAt: string | null;
  stale: boolean;
  tags: string[];
  matchedFields: string[];
  snippet: string;
  citation: Citation;
  /** query-local relative rank (bm25-derived, higher is better); null for LIKE-matched
   *  results, since LIKE has no ranking function -- not comparable across queries and
   *  unrelated to `confidence`. */
  score: number | null;
}

export interface SearchResult {
  results: SearchResultItem[];
  noResults?: boolean;
  query?: string;
  scope?: string | null;
  searchedStatuses?: NoteStatus[];
  guidance?: string;
  suggestedNextTools?: string[];
}

export interface SearchEngine {
  search(input: SearchInput): SearchResult;
}

function splitTerms(query: string): string[] {
  const normalized = normalizeForSearch(query ?? "");
  return normalized.split(/[\s　]+/).filter((t) => t.length > 0);
}

function buildSnippet(originalText: string, normalizedTerm: string): string {
  const normalizedText = normalizeForSearch(originalText);
  const idx = normalizedText.indexOf(normalizedTerm);
  if (idx === -1) {
    return originalText.length > 120 ? `${originalText.slice(0, 120)}...` : originalText;
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(originalText.length, idx + normalizedTerm.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < originalText.length ? "..." : "";
  return `${prefix}${originalText.slice(start, end)}${suffix}`;
}

interface ScoredCandidate {
  row: NoteRow;
  tags: string[];
  matchedFields: string[];
  matchedTermCount: number;
  snippetSource: { field: string; text: string; term: string } | null;
  stale: boolean;
  /** bm25-derived (higher is better), or null if this row wasn't found via FTS5. */
  ftsScore: number | null;
}

/**
 * JS-side re-matching shared by both engines: independent of how a candidate row was
 * found (LIKE narrowing or FTS5 MATCH), this recomputes matched_fields/snippet/
 * matchedTermCount by checking each field directly, so the two engines report identical
 * shapes for the same underlying data.
 */
function scoreCandidates(
  db: CiteHankoDb,
  rows: NoteRow[],
  terms: string[],
  ftsScores: Map<string, number>,
): ScoredCandidate[] {
  return rows.map((row) => {
    const tags = getTags(db, row.id);
    const fieldTexts: Array<[string, string]> = [
      ["title", row.title],
      ["summary", row.summary],
      ["body", row.body],
      ["tags", tags.join(" ")],
    ];

    const matchedFields: string[] = [];
    let matchedTermCount = 0;
    let snippetSource: { field: string; text: string; term: string } | null = null;

    for (const term of terms) {
      let termMatched = false;
      for (const [field, text] of fieldTexts) {
        if (normalizeForSearch(text).includes(term)) {
          if (!matchedFields.includes(field)) matchedFields.push(field);
          termMatched = true;
          if (!snippetSource || field === "body" || field === "summary") {
            snippetSource = { field, text, term };
          }
        }
      }
      if (termMatched) matchedTermCount += 1;
    }

    const stale = isStale({ status: row.status as NoteStatus, reviewDueAt: row.review_due_at });
    return { row, tags, matchedFields, matchedTermCount, snippetSource, stale, ftsScore: ftsScores.get(row.id) ?? null };
  });
}

/** Shared tail end of both engines: filter/sort/paginate/map to SearchResultItem, and
 *  build the no_results shape when the *final* (post-fallback) result set is empty. */
function finalizeResults(
  input: SearchInput,
  terms: string[],
  statuses: NoteStatus[],
  strictStaleFilter: boolean,
  candidates: ScoredCandidate[],
): SearchResult {
  const limit = input.limit ?? DEFAULT_LIMIT;

  // terms.length === 0 (browse-all) keeps every row; otherwise require >=1 matched term.
  const relevant = terms.length === 0 ? candidates : candidates.filter((c) => c.matchedTermCount > 0);
  const filtered = strictStaleFilter ? relevant.filter((c) => !c.stale) : relevant;

  filtered.sort((a, b) => {
    // FTS-scored rows rank by score (bm25-derived, higher is better) first; rows without a
    // score (LIKE-only matches, or the LIKE engine entirely) keep the existing ordering.
    if (a.ftsScore !== null && b.ftsScore !== null) return b.ftsScore - a.ftsScore;
    if (a.ftsScore !== null) return -1;
    if (b.ftsScore !== null) return 1;
    if (b.matchedTermCount !== a.matchedTermCount) return b.matchedTermCount - a.matchedTermCount;
    return b.row.updated_at.localeCompare(a.row.updated_at);
  });

  const top = filtered.slice(0, limit);

  const results: SearchResultItem[] = top.map((c) => {
    const note = c.row;
    const snippet = c.snippetSource ? buildSnippet(c.snippetSource.text, c.snippetSource.term) : note.summary;
    return {
      id: note.id,
      title: note.title,
      summary: note.summary,
      status: note.status as NoteStatus,
      confidence: note.confidence as Confidence,
      scope: note.scope,
      owner: note.owner,
      updatedAt: note.updated_at,
      reviewDueAt: note.review_due_at,
      stale: c.stale,
      tags: c.tags,
      matchedFields: c.matchedFields,
      snippet,
      score: c.ftsScore,
      citation: buildCitation({
        id: note.id,
        title: note.title,
        version: note.version,
        updatedAt: note.updated_at,
        reviewDueAt: note.review_due_at,
        stale: c.stale,
        confidence: note.confidence as Confidence,
        status: note.status as NoteStatus,
        scope: note.scope,
      }),
    };
  });

  if (results.length === 0) {
    return {
      results: [],
      noResults: true,
      query: input.query,
      scope: input.scope ?? null,
      searchedStatuses: statuses,
      guidance:
        "No verified knowledge found for this query. Do not present external or general knowledge as organizational policy. If you have reliable knowledge to contribute, use create_note_draft.",
      suggestedNextTools: ["create_note_draft"],
    };
  }

  return { results };
}

function likeCandidateRows(
  db: CiteHankoDb,
  statuses: NoteStatus[],
  scope: string | null | undefined,
  tags: string[] | undefined,
  terms: string[],
): NoteRow[] {
  const clauses = [`status IN (${statuses.map(() => "?").join(",")})`];
  const params: unknown[] = [...statuses];

  if (scope) {
    clauses.push("scope = ?");
    params.push(scope);
  }
  if (terms.length > 0) {
    clauses.push(`(${terms.map(() => "search_text LIKE ?").join(" OR ")})`);
    params.push(...terms.map((t) => `%${t}%`));
  }
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      clauses.push("EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.id AND nt.tag = ?)");
      params.push(tag);
    }
  }

  return db.prepare(`SELECT * FROM notes WHERE ${clauses.join(" AND ")}`).all(...params) as NoteRow[];
}

/**
 * SQL LIKE on notes.search_text narrows candidates cheaply (works for both space-
 * separated and CJK queries since search_text is already NFKC+lowercased); JS then
 * re-matches per field (title/summary/body/tags) for matched_fields, a snippet, and
 * ranking by number of matched terms. No ranking function, so score is always null.
 */
export function createLikeSearchEngine(ctx: AppContext): SearchEngine {
  const { db, config } = ctx;

  return {
    search(input: SearchInput): SearchResult {
      const includeArchived = input.include_archived ?? false;
      const statuses: NoteStatus[] = includeArchived ? ["verified", "archived"] : ["verified"];
      const terms = splitTerms(input.query);

      const rows = likeCandidateRows(db, statuses, input.scope, input.tags, terms);
      const scored = scoreCandidates(db, rows, terms, new Map());
      return finalizeResults(input, terms, statuses, config.strict_stale_filter, scored);
    },
  };
}

/** SELECT 1 FROM sqlite_master: cheap presence check for the notes_fts table migration
 *  002 creates best-effort (see migrations.ts). This is the single source of truth for
 *  "can this environment actually do FTS5(trigram) search". */
export function hasFts5TrigramSupport(db: CiteHankoDb): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'").get();
  } catch {
    return false;
  }
}

/** Quotes a term as an FTS5 string literal (a phrase token), so arbitrary user text is
 *  matched literally instead of being parsed as FTS5 query syntax (which would throw on
 *  input like unbalanced quotes/parens or a trailing "AND"). */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

interface FtsQueryResult {
  rows: NoteRow[];
  scores: Map<string, number>;
}

/** Runs the FTS5 MATCH query for the given (already length-filtered) terms. Returns null
 *  on any failure (e.g. a pathological query FTS5's parser still rejects despite phrase-
 *  quoting) so the caller can fall back to LIKE for the whole search instead of partially
 *  applying FTS. */
function ftsCandidateRows(
  db: CiteHankoDb,
  statuses: NoteStatus[],
  scope: string | null | undefined,
  tags: string[] | undefined,
  terms: string[],
): FtsQueryResult | null {
  if (terms.length === 0) return { rows: [], scores: new Map() };

  try {
    const clauses = [`n.status IN (${statuses.map(() => "?").join(",")})`];
    const params: unknown[] = [terms.map(ftsPhrase).join(" OR "), ...statuses];

    if (scope) {
      clauses.push("n.scope = ?");
      params.push(scope);
    }
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        clauses.push("EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = ?)");
        params.push(tag);
      }
    }

    const sql = `
      SELECT n.*, bm25(notes_fts) AS fts_rank
        FROM notes_fts
        JOIN notes n ON n.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ? AND ${clauses.join(" AND ")}
    `;
    const rows = db.prepare(sql).all(...params) as (NoteRow & { fts_rank: number })[];
    const scores = new Map<string, number>();
    for (const row of rows) {
      // bm25() is "lower (more negative) is better"; flip the sign so external consumers
      // see the conventional "higher is better".
      scores.set(row.id, -row.fts_rank);
    }
    return { rows, scores };
  } catch {
    return null;
  }
}

/**
 * FTS5(trigram) engine: terms of 3+ characters (the tokenizer's structural minimum) are
 * matched via FTS5 MATCH with a bm25-derived score; shorter terms, or FTS5 query
 * construction/execution failures, fall back to the LIKE engine's candidate gathering for
 * those terms (or, on an FTS5 error, for the whole query). Candidates from both paths are
 * unioned and re-scored via the same JS-side matching as the LIKE engine, so matched_fields/
 * snippet are identical in shape regardless of which path found a given row.
 */
export function createFts5SearchEngine(ctx: AppContext): SearchEngine {
  const { db, config } = ctx;

  return {
    search(input: SearchInput): SearchResult {
      const includeArchived = input.include_archived ?? false;
      const statuses: NoteStatus[] = includeArchived ? ["verified", "archived"] : ["verified"];
      const terms = splitTerms(input.query);

      const ftsEligibleTerms = terms.filter((t) => t.length >= FTS5_MIN_TERM_LENGTH);
      let likeTerms = terms.filter((t) => t.length < FTS5_MIN_TERM_LENGTH);

      let ftsRows: NoteRow[] = [];
      let ftsScores = new Map<string, number>();

      if (ftsEligibleTerms.length > 0) {
        const ftsResult = ftsCandidateRows(db, statuses, input.scope, input.tags, ftsEligibleTerms);
        if (ftsResult) {
          ftsRows = ftsResult.rows;
          ftsScores = ftsResult.scores;
        } else {
          // FTS5 query failed outright (e.g. a pathological string the parser still
          // rejects despite phrase-quoting) -- fall back to LIKE for every term, not just
          // the ones that were already going to use it.
          likeTerms = terms;
        }
      }

      const likeRows =
        terms.length === 0
          ? likeCandidateRows(db, statuses, input.scope, input.tags, [])
          : likeTerms.length > 0
            ? likeCandidateRows(db, statuses, input.scope, input.tags, likeTerms)
            : [];

      const byId = new Map<string, NoteRow>();
      for (const row of ftsRows) byId.set(row.id, row);
      for (const row of likeRows) byId.set(row.id, row);

      const scored = scoreCandidates(db, [...byId.values()], terms, ftsScores);
      // no_results is decided here, on the union after all fallback has already happened.
      return finalizeResults(input, terms, statuses, config.strict_stale_filter, scored);
    },
  };
}

/**
 * Picks the SearchEngine per config.search_engine: "like" always uses LIKE; "fts5" requires
 * FTS5(trigram) support and throws immediately (not a silent LIKE fallback) if this
 * environment's SQLite build doesn't have it; "auto" (default) uses FTS5 when available,
 * else LIKE. Construction is cheap (one sqlite_master lookup), so callers can call this
 * fresh per request; the "fts5 misconfigured" error deliberately surfaces at construction
 * time (effectively "at startup" for both the CLI's per-command process and an MCP server
 * that constructs it up front), not lazily on the first search.
 */
export function createSearchEngine(ctx: AppContext): SearchEngine {
  const mode = ctx.config.search_engine;
  if (mode === "like") return createLikeSearchEngine(ctx);

  const available = hasFts5TrigramSupport(ctx.db);
  if (mode === "fts5") {
    if (!available) {
      throw new CiteHankoError(
        "invalid_input",
        'search_engine: "fts5" is configured, but this environment\'s SQLite build does not support the FTS5 trigram tokenizer',
        {
          suggested_action:
            'set search_engine: "like" (or "auto") in citehanko.config.yaml, or use a better-sqlite3 build with FTS5 trigram support',
        },
      );
    }
    return createFts5SearchEngine(ctx);
  }

  return available ? createFts5SearchEngine(ctx) : createLikeSearchEngine(ctx);
}
