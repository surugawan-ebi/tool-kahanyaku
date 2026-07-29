import { describe, it, expect } from "vitest";
import {
  createFts5SearchEngine,
  createLikeSearchEngine,
  createSearchEngine,
  hasFts5TrigramSupport,
} from "../src/core/search.js";
import { buildSearchText } from "../src/core/searchText.js";
import { CiteHankoError } from "../src/core/errors.js";
import { makeTestContext } from "./helpers.js";
import type { AppContext } from "../src/core/context.js";

function insertNote(
  ctx: AppContext,
  opts: {
    id: string;
    title: string;
    summary: string;
    body?: string;
    status?: string;
    tags?: string[];
  },
) {
  const now = new Date().toISOString();
  const body = opts.body ?? "# 概要\nダミー本文";
  ctx.db
    .prepare(
      `INSERT INTO notes
         (id, slug, title, summary, body, status, confidence, scope, owner, version,
          created_by, reviewed_by, created_at, updated_at, verified_at, archived_at,
          review_due_at, rejection_reason, draft_reason, search_text, metadata_json)
       VALUES
         (@id, @slug, @title, @summary, @body, @status, 'medium', NULL, NULL, 1,
          'tester', NULL, @now, @now, @now, NULL, NULL, NULL, NULL, @search_text, '{}')`,
    )
    .run({
      id: opts.id,
      slug: opts.id,
      title: opts.title,
      summary: opts.summary,
      body,
      status: opts.status ?? "verified",
      now,
      search_text: buildSearchText(opts.title, opts.summary, body, opts.tags ?? []),
    });
  for (const tag of opts.tags ?? []) {
    ctx.db.prepare("INSERT INTO note_tags (note_id, tag) VALUES (?, ?)").run(opts.id, tag);
  }
}

describe("Fts5SearchEngine", () => {
  it("this test environment actually supports FTS5(trigram)", () => {
    // Sanity check: every other test in this file assumes hasFts5TrigramSupport() is true
    // for a freshly-migrated test db. If this fails, the FTS5 tests below are meaningless
    // (they'd all be silently exercising a table that doesn't exist).
    const ctx = makeTestContext();
    expect(hasFts5TrigramSupport(ctx.db)).toBe(true);
  });

  it("matches a 3+ character Japanese term via FTS5 MATCH and returns a numeric score", () => {
    const ctx = makeTestContext();
    insertNote(ctx, {
      id: "note_1",
      title: "返金ポリシー",
      summary: "返金の条件についての要約です。",
      body: "# 概要\nBigQueryへのセグメント連携について説明します。",
    });
    const engine = createFts5SearchEngine(ctx);

    const result = engine.search({ query: "返金ポリシー" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("note_1");
    expect(typeof result.results[0].score).toBe("number");
    expect(result.results[0].matchedFields).toContain("title");
  });

  it("falls back to the LIKE engine for a 1-2 character term (below the trigram minimum)", () => {
    const ctx = makeTestContext();
    insertNote(ctx, { id: "note_ga", title: "GA連携ガイド", summary: "GAのセットアップ手順です。" });
    const engine = createFts5SearchEngine(ctx);

    // "GA" is 2 chars: below FTS5_MIN_TERM_LENGTH, so this note is only findable via the
    // LIKE fallback path, and its score should therefore be null (no bm25 rank available).
    const result = engine.search({ query: "GA" });
    expect(result.results.map((r) => r.id)).toContain("note_ga");
    const hit = result.results.find((r) => r.id === "note_ga")!;
    expect(hit.score).toBeNull();
  });

  it("unions FTS and LIKE candidates for a mixed-length-term query", () => {
    const ctx = makeTestContext();
    // Findable only via the 3+-char FTS path ("返金ポリシー").
    insertNote(ctx, { id: "note_fts_only", title: "返金ポリシー", summary: "返金の条件です。" });
    // Findable only via the short-term LIKE path ("AB", 2 chars).
    insertNote(ctx, { id: "note_like_only", title: "ABガイド", summary: "ABの手順です。" });
    const engine = createFts5SearchEngine(ctx);

    const result = engine.search({ query: "返金ポリシー AB" });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("note_fts_only");
    expect(ids).toContain("note_like_only");
  });

  it("gives verified notes with more matched terms via FTS5 a bm25-derived score (higher = better)", () => {
    const ctx = makeTestContext();
    insertNote(ctx, {
      id: "note_strong",
      title: "返金対応マニュアル",
      summary: "返金対応マニュアルの詳細な要約です。返金対応マニュアル。",
    });
    insertNote(ctx, {
      id: "note_weak",
      title: "その他の話題",
      summary: "この文章にはどこかに返金対応マニュアルという語が一度だけ出てきます。",
    });
    const engine = createFts5SearchEngine(ctx);

    const result = engine.search({ query: "返金対応マニュアル" });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    for (const r of result.results) {
      expect(typeof r.score).toBe("number");
    }
    // Sorted by score descending (higher = better).
    const scores = result.results.map((r) => r.score as number);
    expect([...scores]).toEqual([...scores].sort((a, b) => b - a));
  });

  it("falls back entirely to LIKE when the MATCH query itself is malformed", () => {
    const ctx = makeTestContext();
    insertNote(ctx, { id: "note_quote", title: 'ダブルクォート"付きノート', summary: "特殊文字のテスト用です。" });
    const engine = createFts5SearchEngine(ctx);

    // Should not throw even though the query contains characters that could upset a naive
    // (unquoted) FTS5 MATCH expression.
    expect(() => engine.search({ query: 'クォート"付き' })).not.toThrow();
  });

  it("determines no_results only after the FTS->LIKE fallback has been applied", () => {
    const ctx = makeTestContext();
    const engine = createFts5SearchEngine(ctx);

    const result = engine.search({ query: "存在しないキーワード" });
    expect(result.results).toEqual([]);
    expect(result.noResults).toBe(true);
    expect(result.searchedStatuses).toEqual(["verified"]);
  });

  it("only searches verified notes by default and excludes archived/draft", () => {
    const ctx = makeTestContext();
    insertNote(ctx, { id: "note_v", title: "エスカレーション基準", summary: "対応が難しい場合の基準です。", status: "verified" });
    insertNote(ctx, { id: "note_a", title: "エスカレーション基準旧版", summary: "旧版の基準です。", status: "archived" });
    insertNote(ctx, { id: "note_d", title: "エスカレーション基準ドラフト", summary: "ドラフト中の基準です。", status: "draft" });
    const engine = createFts5SearchEngine(ctx);

    const result = engine.search({ query: "エスカレーション基準" });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("note_v");
    expect(ids).not.toContain("note_a");
    expect(ids).not.toContain("note_d");
  });

  it("respects the limit across the unioned FTS+LIKE candidate set", () => {
    const ctx = makeTestContext();
    for (let i = 0; i < 5; i++) {
      insertNote(ctx, { id: `note_bulk${i}`, title: `共通キーワード${i}`, summary: "共通キーワードを含む要約です。" });
    }
    const engine = createFts5SearchEngine(ctx);

    const result = engine.search({ query: "共通キーワード", limit: 2 });
    expect(result.results).toHaveLength(2);
  });

  it("filters by tags identically to the LIKE engine", () => {
    const ctx = makeTestContext();
    insertNote(ctx, { id: "note_tagged", title: "タグ付きノート案内", summary: "タグでの絞り込みテスト用です。", tags: ["support", "faq"] });
    insertNote(ctx, { id: "note_untagged", title: "タグ付きノート案内2", summary: "タグでの絞り込みテスト用です。", tags: ["eng"] });
    const engine = createFts5SearchEngine(ctx);

    const result = engine.search({ query: "タグ付きノート案内", tags: ["support"] });
    expect(result.results.map((r) => r.id)).toEqual(["note_tagged"]);
  });

  it("re-syncs notes_fts on update, so a stale (pre-update) term stops matching and the new term matches", () => {
    const ctx = makeTestContext();
    insertNote(ctx, { id: "note_upd", title: "旧タイトル文言", summary: "旧要約文言です。" });
    const engine = createFts5SearchEngine(ctx);
    expect(engine.search({ query: "旧タイトル文言" }).results.map((r) => r.id)).toContain("note_upd");

    const now = new Date().toISOString();
    const newSearchText = buildSearchText("新タイトル文言", "新要約文言です。", "# 概要\nダミー本文", []);
    ctx.db
      .prepare("UPDATE notes SET title = ?, summary = ?, search_text = ?, updated_at = ? WHERE id = ?")
      .run("新タイトル文言", "新要約文言です。", newSearchText, now, "note_upd");

    expect(engine.search({ query: "旧タイトル文言" }).results.map((r) => r.id)).not.toContain("note_upd");
    expect(engine.search({ query: "新タイトル文言" }).results.map((r) => r.id)).toContain("note_upd");
  });
});

describe("createSearchEngine factory", () => {
  it('mode "like" always returns a LIKE-only engine (score always null)', () => {
    const ctx = makeTestContext({ config: { search_engine: "like" } });
    insertNote(ctx, { id: "note_1", title: "返金ポリシー案内", summary: "返金の条件についての要約です。" });
    const engine = createSearchEngine(ctx);

    const result = engine.search({ query: "返金ポリシー案内" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBeNull();
  });

  it('mode "auto" (default) uses FTS5 when this environment supports it (score populated for a 3+ char term)', () => {
    const ctx = makeTestContext({ config: { search_engine: "auto" } });
    insertNote(ctx, { id: "note_1", title: "返金ポリシー案内", summary: "返金の条件についての要約です。" });
    const engine = createSearchEngine(ctx);

    const result = engine.search({ query: "返金ポリシー案内" });
    expect(result.results).toHaveLength(1);
    expect(typeof result.results[0].score).toBe("number");
  });

  it('mode "fts5" (explicit) uses FTS5 when supported', () => {
    const ctx = makeTestContext({ config: { search_engine: "fts5" } });
    insertNote(ctx, { id: "note_1", title: "返金ポリシー案内", summary: "返金の条件についての要約です。" });
    const engine = createSearchEngine(ctx);

    const result = engine.search({ query: "返金ポリシー案内" });
    expect(typeof result.results[0].score).toBe("number");
  });

  it('mode "fts5" (explicit) throws a clear CiteHankoError instead of silently falling back when unsupported', () => {
    const ctx = makeTestContext({ config: { search_engine: "fts5" } });
    // Simulate an environment without FTS5 trigram support by dropping the table (and its
    // sync triggers) migration 002 creates best-effort.
    ctx.db.exec("DROP TRIGGER notes_fts_ai; DROP TRIGGER notes_fts_ad; DROP TRIGGER notes_fts_au; DROP TABLE notes_fts;");
    expect(hasFts5TrigramSupport(ctx.db)).toBe(false);

    expect(() => createSearchEngine(ctx)).toThrow(CiteHankoError);
    try {
      createSearchEngine(ctx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CiteHankoError);
      expect((err as CiteHankoError).code).toBe("invalid_input");
    }
  });

  it('mode "auto" silently falls back to LIKE when FTS5 is unsupported (does not throw)', () => {
    const ctx = makeTestContext({ config: { search_engine: "auto" } });
    ctx.db.exec("DROP TRIGGER notes_fts_ai; DROP TRIGGER notes_fts_ad; DROP TRIGGER notes_fts_au; DROP TABLE notes_fts;");
    insertNote(ctx, { id: "note_1", title: "返金ポリシー案内", summary: "返金の条件についての要約です。" });

    const engine = createSearchEngine(ctx);
    const result = engine.search({ query: "返金ポリシー案内" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBeNull();
  });
});

describe("LikeSearchEngine (via factory parity)", () => {
  it("createLikeSearchEngine results always carry score: null", () => {
    const ctx = makeTestContext();
    insertNote(ctx, { id: "note_1", title: "返金ポリシー", summary: "返金の条件についての要約です。" });
    const engine = createLikeSearchEngine(ctx);

    const result = engine.search({ query: "返金ポリシー" });
    expect(result.results[0].score).toBeNull();
  });
});
