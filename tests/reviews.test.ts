import { describe, it, expect, vi } from "vitest";
import { createReviewService } from "../src/core/reviews.js";
import { CiteHankoError } from "../src/core/errors.js";
import { makeTestContext, insertNoteFixture } from "./helpers.js";
import type { AppContext } from "../src/core/context.js";

function captureError(fn: () => unknown): CiteHankoError {
  try {
    fn();
  } catch (err) {
    return err as CiteHankoError;
  }
  throw new Error("expected function to throw");
}

function proposalInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "note_v1",
    base_note_version: 1,
    proposed_body: "# 概要\n更新後の本文です。",
    reason: "古い記述を更新するため",
    source: [{ type: "url" as const, url: "https://example.com" }],
    ...overrides,
  };
}

function ctxAs(base: AppContext, actor: string): AppContext {
  return { ...base, actor };
}

describe("createProposal", () => {
  it("creates a pending_review proposal against a verified note with a diff and changed_fields", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v1", status: "verified", version: 1, body: "# 概要\n古い本文です。" });
    const reviews = createReviewService(ctx);

    const result = reviews.createProposal(proposalInput());

    expect(result.proposal.status).toBe("pending_review");
    expect(result.proposal.noteId).toBe("note_v1");
    expect(result.proposal.baseNoteVersion).toBe(1);
    expect(result.proposal.changedFields).toEqual(["body"]);
    expect(result.proposal.diff).toContain("note_v1");
  });

  it("rejects proposals against draft notes", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_d1", status: "draft" });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.createProposal(proposalInput({ id: "note_d1" })));
    expect(err.code).toBe("invalid_input");
  });

  it("rejects proposals against archived notes", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_a1", status: "archived", version: 1 });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.createProposal(proposalInput({ id: "note_a1", base_note_version: 1 })));
    expect(err.code).toBe("archived_target");
  });

  it("fails with version_conflict when base_note_version does not match, and creates no proposal", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v2", status: "verified", version: 3 });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.createProposal(proposalInput({ id: "note_v2", base_note_version: 1 })));
    expect(err.code).toBe("version_conflict");

    const { items } = reviews.listReviewItems({ kind: "proposal" });
    expect(items).toHaveLength(0);
  });

  it("fails with empty_change when nothing actually changes", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v3", status: "verified", version: 1, title: "同じタイトル" });
    const reviews = createReviewService(ctx);

    const err = captureError(() =>
      reviews.createProposal({
        id: "note_v3",
        base_note_version: 1,
        proposed_title: "同じタイトル",
        reason: "no-op",
        source: [],
      }),
    );
    expect(err.code).toBe("empty_change");
  });
});

describe("approve - draft note", () => {
  it("verifies a draft note created by a different actor (no ownership restriction on review actions)", () => {
    const ctx = makeTestContext({ actor: "reviewer:human" });
    insertNoteFixture(ctx, { id: "note_d2", status: "draft", createdBy: "agent:codex", owner: "support-team", version: 1 });
    const reviews = createReviewService(ctx);

    const result = reviews.approve("note_d2", "looks good");

    expect(result.kind).toBe("note");
    expect(result.note.status).toBe("verified");
    expect(result.note.verifiedAt).not.toBeNull();
    expect(result.note.reviewDueAt).not.toBeNull();
    // spec.md's approve procedure bumps version on every applied change, draft approval included.
    expect(result.note.version).toBe(2);
  });

  it("includes tags and sources (not just the note row) in the note_verified history snapshot", () => {
    const ctx = makeTestContext({ actor: "reviewer:human" });
    insertNoteFixture(ctx, { id: "note_d2b", status: "draft", createdBy: "agent:codex", owner: "support-team", tags: ["support"] });
    ctx.db
      .prepare(
        "INSERT INTO note_sources (id, note_id, type, title, url, path, commit_sha, retrieved_at, metadata_json) VALUES ('src_d2b', 'note_d2b', 'url', 'doc', 'https://example.com', NULL, NULL, NULL, '{}')",
      )
      .run();
    const reviews = createReviewService(ctx);

    reviews.approve("note_d2b", "looks good");

    const events = ctx.db.prepare("SELECT after_snapshot_json FROM history_events WHERE entity_id = 'note_d2b' AND event_type = 'note_verified'").get() as {
      after_snapshot_json: string;
    };
    const snapshot = JSON.parse(events.after_snapshot_json);
    expect(snapshot.tags).toEqual(["support"]);
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0].url).toBe("https://example.com");
  });

  it("includes a reviewer_separation warning (but still approves) when approver === author", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_d3", status: "draft", createdBy: "agent:codex", owner: "support-team" });
    const reviews = createReviewService(ctx);

    const result = reviews.approve("note_d3");
    expect(result.note.status).toBe("verified");
    expect(result.policyWarnings.map((w) => w.code)).toContain("reviewer_separation");
  });

  it("refuses to approve a note that is not a draft", () => {
    const ctx = makeTestContext({ actor: "reviewer:human" });
    insertNoteFixture(ctx, { id: "note_v4", status: "verified" });
    const reviews = createReviewService(ctx);

    expect(() => reviews.approve("note_v4")).toThrow(CiteHankoError);
  });
});

describe("approve - proposal", () => {
  it("applies the proposal to the note, bumps version, and marks the proposal approved", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v5", status: "verified", version: 1, body: "# 概要\n古い本文" });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_v5" }));

    const reviewerCtx = ctxAs(ctx, "reviewer:human");
    const reviewerReviews = createReviewService(reviewerCtx);
    const result = reviewerReviews.approve(proposal.id, "approved");

    expect(result.kind).toBe("proposal");
    expect(result.note.version).toBe(2);
    expect(result.note.body).toContain("更新後の本文");
    expect(result.proposal?.status).toBe("approved");
    expect(result.cascadedNeedsRebase).toEqual([]);
  });

  it("refreshes verified_at and review_due_at on proposal approval, clearing staleness", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    insertNoteFixture(ctx, { id: "note_stale1", status: "verified", version: 1, reviewDueAt: past });
    // Backdate verified_at itself (insertNoteFixture always stamps "now") so the "did this
    // actually get refreshed" assertion below isn't relying on two Date.now() calls landing
    // in different milliseconds.
    ctx.db.prepare("UPDATE notes SET verified_at = ? WHERE id = ?").run(past, "note_stale1");
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_stale1" }));

    const result = reviews.approve(proposal.id, "approved");

    expect(result.note.reviewDueAt).not.toBeNull();
    expect(result.note.reviewDueAt! > new Date().toISOString()).toBe(true);
    expect(result.note.verifiedAt).not.toBeNull();
    expect(result.note.verifiedAt!).not.toBe(past);
    expect(result.note.verifiedAt! > past).toBe(true);
  });

  it("appends the proposal's source[] into note_sources on approval (additive merge, not a replace)", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_src1", status: "verified", version: 1 });
    ctx.db
      .prepare(
        "INSERT INTO note_sources (id, note_id, type, title, url, path, commit_sha, retrieved_at, metadata_json) VALUES ('src_existing', 'note_src1', 'manual', 'original doc', NULL, NULL, NULL, NULL, '{}')",
      )
      .run();
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(
      proposalInput({ id: "note_src1", source: [{ type: "url", url: "https://example.com/new" }] }),
    );

    reviews.approve(proposal.id, "approved");

    const sources = ctx.db.prepare("SELECT type, url FROM note_sources WHERE note_id = 'note_src1' ORDER BY type").all() as Array<{
      type: string;
      url: string | null;
    }>;
    expect(sources).toEqual([
      { type: "manual", url: null },
      { type: "url", url: "https://example.com/new" },
    ]);
  });

  it("skips a proposal source that already exists on the note (same type+url+path), avoiding duplicates", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_src2", status: "verified", version: 1 });
    ctx.db
      .prepare(
        "INSERT INTO note_sources (id, note_id, type, title, url, path, commit_sha, retrieved_at, metadata_json) VALUES ('src_dup', 'note_src2', 'url', 'existing', 'https://example.com/dup', NULL, NULL, NULL, '{}')",
      )
      .run();
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(
      proposalInput({ id: "note_src2", source: [{ type: "url", url: "https://example.com/dup" }] }),
    );

    reviews.approve(proposal.id, "approved");

    const count = ctx.db.prepare("SELECT COUNT(*) AS c FROM note_sources WHERE note_id = 'note_src2'").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("on version mismatch, commits the proposal to needs_rebase THEN throws version_conflict", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v6", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_v6" }));

    // Someone else's proposal (or a direct edit) bumps the note's version before this one is approved.
    ctx.db.prepare("UPDATE notes SET version = 2 WHERE id = ?").run("note_v6");

    const err = captureError(() => reviews.approve(proposal.id));
    expect(err.code).toBe("version_conflict");

    // The needs_rebase transition must have survived even though approve() threw.
    const item = reviews.getReviewItem(proposal.id);
    expect(item.status).toBe("needs_rebase");
    expect(item.suggestedAction).toBe("fetch current note and resubmit");
    expect(item.baseNoteVersion).toBe(1);
    expect(item.currentNoteVersion).toBe(2);
  });

  it("closes the TOCTOU window: a version change that lands between the pre-check and the transaction's commit still results in needs_rebase, never a stale apply", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_toctou", status: "verified", version: 1, body: "# 概要\n古い本文" });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_toctou" }));

    // Simulate a second process (e.g. the MCP server and a CLI invocation sharing the same
    // db file) bumping the note's version *after* approve()'s cheap pre-check has already
    // read it as matching, but *before* runApprove()'s transaction begins. db.transaction(fn)
    // only builds a wrapper -- it doesn't run fn -- so intercepting the wrapper's invocation
    // and committing the "concurrent" write as its own independent statement first (i.e.
    // *before* entering the transaction being tested, so it isn't rolled back along with it
    // if that transaction fails) reproduces exactly the race window fix 1 closes. The
    // correctness guard under test is the transaction's own WHERE clause, not this outer
    // pre-check, so this must still resolve to needs_rebase/version_conflict.
    const buildRealTransaction = ctx.db.transaction.bind(ctx.db);
    let injected = false;
    vi.spyOn(ctx.db, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
      const invokeReal = buildRealTransaction(fn);
      return (...args: unknown[]) => {
        if (!injected) {
          injected = true;
          ctx.db.prepare("UPDATE notes SET version = 2 WHERE id = ?").run("note_toctou");
        }
        return invokeReal(...args);
      };
    }) as typeof ctx.db.transaction);

    try {
      const err = captureError(() => reviews.approve(proposal.id));
      expect(err.code).toBe("version_conflict");
      expect((err.details as { current_version: number }).current_version).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }

    // The proposal's stale content must never have been applied -- only the "concurrent
    // writer's" version bump is visible.
    const noteRow = ctx.db.prepare("SELECT version, body FROM notes WHERE id = ?").get("note_toctou") as {
      version: number;
      body: string;
    };
    expect(noteRow.version).toBe(2);
    expect(noteRow.body).not.toContain("更新後の本文");

    const item = reviews.getReviewItem(proposal.id);
    expect(item.status).toBe("needs_rebase");
    expect(item.baseNoteVersion).toBe(1);
    expect(item.currentNoteVersion).toBe(2);
  });

  it("cascades other pending proposals on the same note to needs_rebase on approval", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v7", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const first = reviews.createProposal(proposalInput({ id: "note_v7", proposed_body: "# 概要\n提案A" }));
    const second = reviews.createProposal(
      proposalInput({ id: "note_v7", proposed_summary: "提案Bによる新しい要約文章です。二十文字以上あります。" }),
    );

    const result = reviews.approve(first.proposal.id);
    expect(result.cascadedNeedsRebase).toEqual([second.proposal.id]);

    const secondItem = reviews.getReviewItem(second.proposal.id);
    expect(secondItem.status).toBe("needs_rebase");
  });

  it("refuses to approve a proposal that is already approved or rejected", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v8", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_v8" }));
    reviews.approve(proposal.id);

    expect(() => reviews.approve(proposal.id)).toThrow(CiteHankoError);
  });
});

describe("reject", () => {
  it("rejects a draft note and records the reason", () => {
    const ctx = makeTestContext({ actor: "reviewer:human" });
    insertNoteFixture(ctx, { id: "note_d4", status: "draft", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    const result = reviews.reject("note_d4", "insufficient evidence");
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("insufficient evidence");
    expect(result.note?.status).toBe("rejected");
  });

  it("rejects a pending proposal and records the reason", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_v9", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_v9" }));

    const result = reviews.reject(proposal.id, "not needed");
    expect(result.status).toBe("rejected");
    expect(result.proposal?.status).toBe("rejected");
  });

  it("requires a reason", () => {
    const ctx = makeTestContext({ actor: "reviewer:human" });
    insertNoteFixture(ctx, { id: "note_d5", status: "draft" });
    const reviews = createReviewService(ctx);

    expect(() => reviews.reject("note_d5", "")).toThrow(CiteHankoError);
  });

  it("refuses to reject a note that is not a draft", () => {
    const ctx = makeTestContext({ actor: "reviewer:human" });
    insertNoteFixture(ctx, { id: "note_v10", status: "verified" });
    const reviews = createReviewService(ctx);

    expect(() => reviews.reject("note_v10", "no")).toThrow(CiteHankoError);
  });
});

describe("listReviewItems", () => {
  it("lists drafts and proposals together, oldest first by default", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l1", status: "draft", scope: "support" });
    insertNoteFixture(ctx, { id: "note_l2", status: "verified", version: 1, scope: "support" });
    const reviews = createReviewService(ctx);
    reviews.createProposal(proposalInput({ id: "note_l2" }));

    const { items } = reviews.listReviewItems({});
    expect(items.map((i) => i.kind).sort()).toEqual(["draft", "proposal"]);
  });

  it("filters by kind, scope, and createdBy=self", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l3", status: "draft", createdBy: "agent:codex", scope: "support" });
    insertNoteFixture(ctx, { id: "note_l4", status: "draft", createdBy: "agent:other", scope: "support" });
    insertNoteFixture(ctx, { id: "note_l5", status: "draft", createdBy: "agent:codex", scope: "eng" });
    const reviews = createReviewService(ctx);

    const { items: mine } = reviews.listReviewItems({ kind: "draft", scope: "support", createdBy: "self" });
    expect(mine.map((i) => i.id)).toEqual(["note_l3"]);
  });

  it("respects an explicit limit", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l6", status: "draft" });
    insertNoteFixture(ctx, { id: "note_l7", status: "draft" });
    const reviews = createReviewService(ctx);

    const { items } = reviews.listReviewItems({ kind: "draft", limit: 1 });
    expect(items).toHaveLength(1);
  });

  it("defaults to a limit of 20 when none is given", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    for (let i = 0; i < 25; i++) {
      insertNoteFixture(ctx, { id: `note_bulk${i}`, status: "draft" });
    }
    const reviews = createReviewService(ctx);

    const { items, nextCursor } = reviews.listReviewItems({ kind: "draft" });
    expect(items).toHaveLength(20);
    expect(nextCursor).toBe(items[19].id);
  });

  it("returns nextCursor:null when the page is not full", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l8", status: "draft" });
    const reviews = createReviewService(ctx);

    const { items, nextCursor } = reviews.listReviewItems({ kind: "draft" });
    expect(items).toHaveLength(1);
    expect(nextCursor).toBeNull();
  });

  it("normalizes a draft note's status to pending_review, keeping noteStatus as the raw value", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l9", status: "draft" });
    const reviews = createReviewService(ctx);

    const { items } = reviews.listReviewItems({ kind: "draft" });
    expect(items[0].status).toBe("pending_review");
    expect(items[0].noteStatus).toBe("draft");
  });

  it("status:pending_review matches both a draft note and a pending_review proposal", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l10", status: "draft", scope: "support" });
    insertNoteFixture(ctx, { id: "note_l11", status: "verified", version: 1, scope: "support" });
    const reviews = createReviewService(ctx);
    reviews.createProposal(proposalInput({ id: "note_l11" }));

    const { items } = reviews.listReviewItems({ status: "pending_review" });
    expect(items.map((i) => i.kind).sort()).toEqual(["draft", "proposal"]);
  });

  it("status:rejected matches both a rejected note and a rejected proposal", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l12", status: "rejected" });
    insertNoteFixture(ctx, { id: "note_l13", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_l13" }));
    reviews.reject(proposal.id, "not needed");

    const { items } = reviews.listReviewItems({ status: "rejected" });
    expect(items.map((i) => i.kind).sort()).toEqual(["draft", "proposal"]);
  });

  it("status:needs_rebase matches only proposals, never notes", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_l14", status: "draft" });
    insertNoteFixture(ctx, { id: "note_l15", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_l15" }));
    ctx.db.prepare("UPDATE update_proposals SET status='needs_rebase' WHERE id=?").run(proposal.id);

    const { items } = reviews.listReviewItems({ status: "needs_rebase" });
    expect(items.map((i) => i.id)).toEqual([proposal.id]);
  });
});

describe("getReviewItem", () => {
  it("always sets usable_as_context to false", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_g1", status: "draft" });
    const reviews = createReviewService(ctx);

    expect(reviews.getReviewItem("note_g1").usableAsContext).toBe(false);
  });

  it("includes draft_reason and rejection_reason for a note", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_g2", status: "rejected" });
    ctx.db.prepare("UPDATE notes SET rejection_reason = 'too vague', draft_reason = 'no formal source' WHERE id = ?").run(
      "note_g2",
    );
    const reviews = createReviewService(ctx);

    const item = reviews.getReviewItem("note_g2");
    expect(item.rejectionReason).toBe("too vague");
    expect(item.draftReason).toBe("no formal source");
  });

  it("includes reason/source/proposedBy/changedFields for a proposal", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_g3", status: "verified", version: 1, body: "# 概要\n古い本文" });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal(proposalInput({ id: "note_g3" }));

    const item = reviews.getReviewItem(proposal.id);
    expect(item.reason).toBe("古い記述を更新するため");
    expect(item.proposedBy).toBe("agent:codex");
    expect(item.changedFields).toEqual(["body"]);
    expect(item.source).toEqual([{ type: "url", url: "https://example.com" }]);
  });
});
