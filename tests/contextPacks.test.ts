import { describe, it, expect } from "vitest";
import { createContextPackService } from "../src/core/contextPacks.js";
import { CiteHankoError } from "../src/core/errors.js";
import { makeTestContext, insertNoteFixture } from "./helpers.js";
import type { AppContext } from "../src/core/context.js";
import type { ContextPackConfig } from "../src/config/config.js";

function ctxWithPacks(
  packs: Record<string, Partial<ContextPackConfig>>,
  overrides: Partial<AppContext> & { config?: Partial<AppContext["config"]> } = {},
): AppContext {
  const context_packs: Record<string, ContextPackConfig> = {};
  for (const [name, p] of Object.entries(packs)) {
    context_packs[name] = { description: p.description ?? "", scopes: p.scopes ?? [], tags: p.tags ?? [], note_ids: p.note_ids ?? [] };
  }
  const { config: configOverrides, ...rest } = overrides;
  return makeTestContext({ config: { context_packs, ...configOverrides }, ...rest });
}

describe("context pack selector semantics", () => {
  it("scopes are OR'd: a note matches if its scope is any one of the listed scopes", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support", "eng"] } });
    insertNoteFixture(ctx, { id: "note_support", status: "verified", scope: "support" });
    insertNoteFixture(ctx, { id: "note_eng", status: "verified", scope: "eng" });
    insertNoteFixture(ctx, { id: "note_other", status: "verified", scope: "other" });

    const result = createContextPackService(ctx).getPack("p1");
    const ids = result.notes.map((n) => n.id);
    expect(ids).toContain("note_support");
    expect(ids).toContain("note_eng");
    expect(ids).not.toContain("note_other");
  });

  it("tags are AND'd: a note must have every listed tag, not just one", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"], tags: ["faq", "billing"] } });
    insertNoteFixture(ctx, { id: "note_both", status: "verified", scope: "support", tags: ["faq", "billing"] });
    insertNoteFixture(ctx, { id: "note_one", status: "verified", scope: "support", tags: ["faq"] });
    insertNoteFixture(ctx, { id: "note_none", status: "verified", scope: "support", tags: [] });

    const result = createContextPackService(ctx).getPack("p1");
    const ids = result.notes.map((n) => n.id);
    expect(ids).toEqual(["note_both"]);
  });

  it("an empty tags[] is vacuously satisfied (no tag filter) when scopes is non-empty", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"], tags: [] } });
    insertNoteFixture(ctx, { id: "note_a", status: "verified", scope: "support", tags: ["random"] });
    insertNoteFixture(ctx, { id: "note_b", status: "verified", scope: "support" });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes.map((n) => n.id).sort()).toEqual(["note_a", "note_b"]);
  });

  it("an empty scopes[] contributes nothing via the scope/tag path -- only note_ids pins apply", () => {
    const ctx = ctxWithPacks({ p1: { scopes: [], tags: [], note_ids: ["note_pinned"] } });
    insertNoteFixture(ctx, { id: "note_pinned", status: "verified", scope: "support" });
    insertNoteFixture(ctx, { id: "note_unpinned", status: "verified", scope: "support" });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes.map((n) => n.id)).toEqual(["note_pinned"]);
  });

  it("unions scope/tag matches with explicit note_ids pins, without duplicates", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"], note_ids: ["note_pinned_eng"] } });
    insertNoteFixture(ctx, { id: "note_scoped", status: "verified", scope: "support" });
    insertNoteFixture(ctx, { id: "note_pinned_eng", status: "verified", scope: "eng" });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes.map((n) => n.id).sort()).toEqual(["note_pinned_eng", "note_scoped"]);
  });
});

describe("context pack exclusions", () => {
  it("never distributes an archived note, even when explicitly pinned via note_ids", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"], note_ids: ["note_archived"] } });
    insertNoteFixture(ctx, { id: "note_archived", status: "archived", scope: "support" });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes).toEqual([]);
    expect(result.excluded).toEqual([{ id: "note_archived", reason: "archived" }]);
  });

  it("excludes a pinned draft/rejected note with reason not_verified", () => {
    const ctx = ctxWithPacks({ p1: { note_ids: ["note_draft", "note_rejected"] } });
    insertNoteFixture(ctx, { id: "note_draft", status: "draft" });
    insertNoteFixture(ctx, { id: "note_rejected", status: "rejected" });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes).toEqual([]);
    expect(result.excluded).toEqual([
      { id: "note_draft", reason: "not_verified" },
      { id: "note_rejected", reason: "not_verified" },
    ]);
  });

  it("excludes a pinned id that doesn't correspond to any note, with reason not_found", () => {
    const ctx = ctxWithPacks({ p1: { note_ids: ["note_does_not_exist"] } });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.excluded).toEqual([{ id: "note_does_not_exist", reason: "not_found" }]);
  });

  it("excludes a stale note with reason stale_filtered when strict_stale_filter is true", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } }, { config: { strict_stale_filter: true } });
    insertNoteFixture(ctx, { id: "note_stale", status: "verified", scope: "support", reviewDueAt: past });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes).toEqual([]);
    expect(result.excluded).toEqual([{ id: "note_stale", reason: "stale_filtered" }]);
  });

  it("includes a stale note with citation.stale:true and a pack-level warning when strict_stale_filter is false", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } }, { config: { strict_stale_filter: false } });
    insertNoteFixture(ctx, { id: "note_stale", status: "verified", scope: "support", reviewDueAt: past });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes.map((n) => n.id)).toEqual(["note_stale"]);
    expect(result.notes[0].stale).toBe(true);
    expect(result.notes[0].citation.stale).toBe(true);
    expect(result.excluded).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("1");
  });
});

describe("get_context_pack include_body", () => {
  it("defaults to no body", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } });
    insertNoteFixture(ctx, { id: "note_1", status: "verified", scope: "support", body: "# 概要\n本文" });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.notes[0].body).toBeUndefined();
  });

  it("include_body:true returns the full body when under max_body_chars", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } });
    insertNoteFixture(ctx, { id: "note_1", status: "verified", scope: "support", body: "# 概要\n短い本文" });

    const result = createContextPackService(ctx).getPack("p1", { includeBody: true });
    expect(result.notes[0].body).toBe("# 概要\n短い本文");
    expect(result.notes[0].bodyTruncated).toBe(false);
  });

  it("truncates a body longer than max_body_chars and sets bodyTruncated:true", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } }, { config: { max_body_chars: 20 } });
    insertNoteFixture(ctx, { id: "note_1", status: "verified", scope: "support", body: "x".repeat(100) });

    const result = createContextPackService(ctx).getPack("p1", { includeBody: true });
    expect(result.notes[0].body).toHaveLength(20);
    expect(result.notes[0].bodyTruncated).toBe(true);
  });

  it("lowers the default limit when include_body is true", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } });
    for (let i = 0; i < 25; i++) {
      insertNoteFixture(ctx, { id: `note_${i}`, status: "verified", scope: "support" });
    }
    const service = createContextPackService(ctx);

    const withoutBody = service.getPack("p1");
    expect(withoutBody.notes).toHaveLength(25);

    const withBody = service.getPack("p1", { includeBody: true });
    expect(withBody.notes.length).toBeLessThan(25);
    expect(withBody.notes.length).toBeLessThanOrEqual(20);
    expect(withBody.truncated).toBe(true);
    expect(withBody.nextCursor).not.toBeNull();
  });
});

describe("get_context_pack pagination", () => {
  it("respects an explicit limit and returns a usable next_cursor", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } });
    for (let i = 0; i < 5; i++) {
      insertNoteFixture(ctx, { id: `note_${i}`, status: "verified", scope: "support" });
    }
    const service = createContextPackService(ctx);

    const first = service.getPack("p1", { limit: 2 });
    expect(first.notes).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = service.getPack("p1", { limit: 2, cursor: first.nextCursor });
    expect(second.notes).toHaveLength(2);
    // No overlap between pages.
    expect(second.notes.map((n) => n.id)).not.toContain(first.notes[0].id);
    expect(second.notes.map((n) => n.id)).not.toContain(first.notes[1].id);
  });

  it("truncated:false and next_cursor:null when everything fits in one page", () => {
    const ctx = ctxWithPacks({ p1: { scopes: ["support"] } });
    insertNoteFixture(ctx, { id: "note_1", status: "verified", scope: "support" });

    const result = createContextPackService(ctx).getPack("p1");
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

describe("get_context_pack errors", () => {
  it("throws not_found for an unknown pack name, with available pack names as suggested_action", () => {
    const ctx = ctxWithPacks({ existing_pack: {} });

    try {
      createContextPackService(ctx).getPack("nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CiteHankoError);
      const e = err as CiteHankoError;
      expect(e.code).toBe("not_found");
      expect(e.suggested_action).toContain("existing_pack");
    }
  });

  it("gives a helpful suggested_action when no packs are configured at all", () => {
    const ctx = makeTestContext();
    try {
      createContextPackService(ctx).getPack("anything");
      expect.unreachable();
    } catch (err) {
      const e = err as CiteHankoError;
      expect(e.code).toBe("not_found");
      expect(e.suggested_action).toContain("context_packs");
    }
  });
});

describe("listPacks", () => {
  it("reports the live note count for each configured pack", () => {
    const ctx = ctxWithPacks({
      support_pack: { scopes: ["support"] },
      empty_pack: { scopes: ["nonexistent"] },
    });
    insertNoteFixture(ctx, { id: "note_1", status: "verified", scope: "support" });
    insertNoteFixture(ctx, { id: "note_2", status: "verified", scope: "support" });

    const summaries = createContextPackService(ctx).listPacks();
    const support = summaries.find((p) => p.name === "support_pack");
    const empty = summaries.find((p) => p.name === "empty_pack");
    expect(support?.noteCount).toBe(2);
    expect(empty?.noteCount).toBe(0);
  });
});
