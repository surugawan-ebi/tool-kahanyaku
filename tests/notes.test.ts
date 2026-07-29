import { describe, it, expect } from "vitest";
import { createNoteService } from "../src/core/notes.js";
import { CiteHankoError } from "../src/core/errors.js";
import { makeTestContext, insertNoteFixture } from "./helpers.js";

const goodBody = "# 概要\n本文です。\n\n# 正本回答\nこれが正本回答です。";
const goodSummary = "これは十分な長さのある要約文です。二十文字を超えています。";

function captureError(fn: () => unknown): CiteHankoError {
  try {
    fn();
  } catch (err) {
    return err as CiteHankoError;
  }
  throw new Error("expected function to throw");
}

function baseDraftInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "返金ポリシー",
    summary: goodSummary,
    body: goodBody,
    tags: ["support"],
    source: [{ type: "url" as const, url: "https://example.com/policy" }],
    reason: null,
    confidence: "medium" as const,
    scope: "support",
    ...overrides,
  };
}

describe("createDraft", () => {
  it("creates a draft note with a slugified id and records history", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);

    const result = notes.createDraft(baseDraftInput());

    expect(result.note.status).toBe("draft");
    expect(result.note.version).toBe(1);
    expect(result.note.createdBy).toBe("agent:codex");
    expect(result.note.slug).toBe("返金ポリシー");
    expect(result.slugAdjusted).toBe(false);
    expect(result.policyWarnings).toEqual([]);

    const detail = notes.getNoteForReview(result.note.id);
    expect(detail.tags).toEqual(["support"]);
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0].url).toBe("https://example.com/policy");
  });

  it("auto-suffixes the slug on collision", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);

    const first = notes.createDraft(baseDraftInput({ title: "エスカレーション基準" }));
    const second = notes.createDraft(baseDraftInput({ title: "エスカレーション基準" }));
    const third = notes.createDraft(baseDraftInput({ title: "エスカレーション基準" }));

    expect(first.note.slug).toBe("エスカレーション基準");
    expect(second.slugAdjusted).toBe(true);
    expect(second.note.slug).toBe("エスカレーション基準-2");
    expect(third.note.slug).toBe("エスカレーション基準-3");
  });

  it("requires at least one of source or reason", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);

    const err = captureError(() => notes.createDraft(baseDraftInput({ source: [], reason: null })));
    expect(err).toBeInstanceOf(CiteHankoError);
    expect(err.code).toBe("invalid_input");
  });

  it("wraps schema validation failures as invalid_input, not a raw ZodError", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);

    const err = captureError(() => notes.createDraft(baseDraftInput({ title: "" })));
    expect(err).toBeInstanceOf(CiteHankoError);
    expect(err.code).toBe("invalid_input");
  });

  it("allows reason alone but still warns missing_source", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);

    const result = notes.createDraft(baseDraftInput({ source: [], reason: "no formal source yet" }));
    expect(result.note.status).toBe("draft");
    expect(result.policyWarnings.map((w) => w.code)).toContain("missing_source");
  });

  it("computes and persists possible_duplicates on the note metadata", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);

    const first = notes.createDraft(baseDraftInput({ title: "返金ポリシー", summary: goodSummary }));
    // approve-equivalent: mark the first as verified directly so it's visible to duplicate search
    ctx.db.prepare("UPDATE notes SET status='verified' WHERE id=?").run(first.note.id);

    const second = notes.createDraft(baseDraftInput({ title: "返金ポリシーの詳細" }));
    expect(second.possibleDuplicates.length).toBeGreaterThan(0);
    expect(second.possibleDuplicates[0].id).toBe(first.note.id);
    expect(second.note.metadata.possible_duplicates).toEqual(second.possibleDuplicates);
  });
});

describe("updateDraft", () => {
  it("lets the owning actor edit their own draft and bumps the version", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    const created = notes.createDraft(baseDraftInput());

    const result = notes.updateDraft({ id: created.note.id, title: "返金ポリシー（改訂版）" });

    expect(result.note.title).toBe("返金ポリシー（改訂版）");
    expect(result.note.version).toBe(2);
    expect(result.resubmitted).toBe(false);
    expect(result.note.status).toBe("draft");
  });

  it("includes tags and sources (not just the note row) in the note_updated history snapshot", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    const created = notes.createDraft(baseDraftInput());

    notes.updateDraft({ id: created.note.id, title: "返金ポリシー（改訂版）" });

    const row = ctx.db
      .prepare("SELECT before_snapshot_json, after_snapshot_json FROM history_events WHERE entity_id = ? AND event_type = 'note_updated'")
      .get(created.note.id) as { before_snapshot_json: string; after_snapshot_json: string };
    const before = JSON.parse(row.before_snapshot_json);
    const after = JSON.parse(row.after_snapshot_json);
    expect(before.tags).toEqual(["support"]);
    expect(before.sources).toHaveLength(1);
    expect(before.sources[0].url).toBe("https://example.com/policy");
    expect(after.tags).toEqual(["support"]);
    expect(after.sources).toHaveLength(1);
    expect(after.note.title).toBe("返金ポリシー（改訂版）");
  });

  it("rejects edits from a different actor", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    const created = notes.createDraft(baseDraftInput());

    const otherCtx = { ...ctx, actor: "agent:other" };
    const otherNotes = createNoteService(otherCtx);

    const err = captureError(() => otherNotes.updateDraft({ id: created.note.id, title: "乗っ取り" }));
    expect(err.code).toBe("not_draft_owner");
  });

  it("moves a rejected note back to draft and records note_resubmitted", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_rejected1", status: "rejected", createdBy: "agent:codex", version: 3 });

    const result = notes.updateDraft({ id: "note_rejected1", body: "更新済み本文" });

    expect(result.resubmitted).toBe(true);
    expect(result.note.status).toBe("draft");
    expect(result.note.version).toBe(4);
  });

  it("refuses to edit a verified note", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_verified1", status: "verified", createdBy: "agent:codex" });

    expect(() => notes.updateDraft({ id: "note_verified1", title: "x" })).toThrow(CiteHankoError);
  });

  it("refuses to edit an archived note", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_archived1", status: "archived", createdBy: "agent:codex" });

    const err = captureError(() => notes.updateDraft({ id: "note_archived1", title: "x" }));
    expect(err.code).toBe("archived_target");
  });
});

describe("getVerifiedNote", () => {
  it("returns verified notes with detail", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_v1", status: "verified", tags: ["support"] });

    const detail = notes.getVerifiedNote("note_v1");
    expect(detail.status).toBe("verified");
    expect(detail.tags).toEqual(["support"]);
  });

  it("returns archived notes too", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_a1", status: "archived" });

    expect(notes.getVerifiedNote("note_a1").status).toBe("archived");
  });

  it("rejects draft notes with not_verified", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_d1", status: "draft" });

    const err = captureError(() => notes.getVerifiedNote("note_d1"));
    expect(err.code).toBe("not_verified");
    expect(err.details).toEqual({ status: "draft" });
  });

  it("rejects rejected notes with not_verified", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_r1", status: "rejected" });

    expect(() => notes.getVerifiedNote("note_r1")).toThrow(CiteHankoError);
  });

  it("throws not_found for an unknown id", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    expect(() => notes.getVerifiedNote("note_missing")).toThrow(CiteHankoError);
  });
});

describe("getNoteForReview", () => {
  it("returns notes regardless of status", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_any", status: "rejected" });

    expect(notes.getNoteForReview("note_any").status).toBe("rejected");
  });
});

describe("archiveNote", () => {
  it("archives a verified note and records history", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_v2", status: "verified" });

    const archived = notes.archiveNote("note_v2", "superseded by newer policy");
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();
  });

  it("refuses to archive a note that is already archived", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_a2", status: "archived" });

    const err = captureError(() => notes.archiveNote("note_a2", "again"));
    expect(err.code).toBe("archived_target");
  });

  it("refuses to archive a draft note", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_d2", status: "draft" });

    expect(() => notes.archiveNote("note_d2", "not verified yet")).toThrow(CiteHankoError);
  });
});

describe("listNotes", () => {
  it("filters by status and scope", () => {
    const ctx = makeTestContext();
    const notes = createNoteService(ctx);
    insertNoteFixture(ctx, { id: "note_l1", status: "verified", scope: "support" });
    insertNoteFixture(ctx, { id: "note_l2", status: "draft", scope: "support" });
    insertNoteFixture(ctx, { id: "note_l3", status: "verified", scope: "eng" });

    const verifiedSupport = notes.listNotes({ status: "verified", scope: "support" });
    expect(verifiedSupport.map((n) => n.id)).toEqual(["note_l1"]);
  });
});
