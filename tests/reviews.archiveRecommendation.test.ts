import { describe, it, expect } from "vitest";
import { createReviewService } from "../src/core/reviews.js";
import { KahanyakuError } from "../src/core/errors.js";
import { makeTestContext, insertNoteFixture } from "./helpers.js";
import type { AppContext } from "../src/core/context.js";

function captureError(fn: () => unknown): KahanyakuError {
  try {
    fn();
  } catch (err) {
    return err as KahanyakuError;
  }
  throw new Error("expected function to throw");
}

function ctxAs(base: AppContext, actor: string): AppContext {
  return { ...base, actor };
}

describe("createArchiveRecommendation", () => {
  it("creates a pending_review archive_recommendation proposal with no content change", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_ar1", status: "verified", version: 3 });
    const reviews = createReviewService(ctx);

    const result = reviews.createArchiveRecommendation({ note_id: "note_ar1", reason: "料金体系が2026年に刷新されたため" });

    expect(result.proposal.status).toBe("pending_review");
    expect(result.proposal.proposalType).toBe("archive_recommendation");
    expect(result.proposal.noteId).toBe("note_ar1");
    expect(result.proposal.baseNoteVersion).toBe(3);
    expect(result.proposal.diff).toBe("");
    expect(result.proposal.changedFields).toEqual([]);
    expect(result.proposal.reason).toBe("料金体系が2026年に刷新されたため");
    expect(result.proposal.proposedTitle).toBeNull();
    expect(result.proposal.proposedBody).toBeNull();
  });

  it("records a proposal_created history event", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_ar2", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);

    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_ar2", reason: "古くなった" });

    const events = ctx.db
      .prepare("SELECT event_type, reason FROM history_events WHERE entity_id = ?")
      .all(proposal.id) as Array<{ event_type: string; reason: string | null }>;
    expect(events).toEqual([{ event_type: "proposal_created", reason: "古くなった" }]);
  });

  it("rejects a recommendation against a draft note with not_verified", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_ard1", status: "draft" });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.createArchiveRecommendation({ note_id: "note_ard1", reason: "x" }));
    expect(err.code).toBe("not_verified");
  });

  it("rejects a recommendation against a rejected note with not_verified", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_arr1", status: "rejected" });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.createArchiveRecommendation({ note_id: "note_arr1", reason: "x" }));
    expect(err.code).toBe("not_verified");
  });

  it("rejects a recommendation against an already-archived note with archived_target", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_ara1", status: "archived", version: 1 });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.createArchiveRecommendation({ note_id: "note_ara1", reason: "x" }));
    expect(err.code).toBe("archived_target");
  });

  it("requires a non-empty reason", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_arreq1", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);

    expect(() => reviews.createArchiveRecommendation({ note_id: "note_arreq1", reason: "" })).toThrow(KahanyakuError);
  });
});

describe("approve - archive_recommendation", () => {
  it("archives the target note and records note_archived + proposal_approved history", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_aa1", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_aa1", reason: "旧料金プランのため" });

    const reviewerReviews = createReviewService(ctxAs(ctx, "reviewer:human"));
    const result = reviewerReviews.approve(proposal.id, "confirmed obsolete");

    expect(result.kind).toBe("proposal");
    expect(result.note.status).toBe("archived");
    expect(result.note.archivedAt).not.toBeNull();
    expect(result.proposal?.status).toBe("approved");

    const eventTypes = ctx.db
      .prepare("SELECT entity_type, event_type FROM history_events WHERE entity_id IN (?, ?) ORDER BY rowid")
      .all("note_aa1", proposal.id) as Array<{ entity_type: string; event_type: string }>;
    expect(eventTypes).toContainEqual({ entity_type: "note", event_type: "note_archived" });
    expect(eventTypes).toContainEqual({ entity_type: "proposal", event_type: "proposal_approved" });
  });

  it("does not require/consume a content-version lock: an unrelated version bump does not block approval", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_aa2", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_aa2", reason: "obsolete" });

    // Simulate another approved content-update proposal bumping the note's version in the
    // meantime -- still verified, just newer. The archive recommendation has no content to
    // apply, so this alone must not block it (unlike a normal update proposal).
    ctx.db.prepare("UPDATE notes SET version = 5 WHERE id = ?").run("note_aa2");

    const result = reviews.approve(proposal.id);
    expect(result.note.status).toBe("archived");
  });

  it("cascades other pending update proposals on the same note to needs_rebase", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_aa3", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const updateProposal = reviews.createProposal({
      id: "note_aa3",
      base_note_version: 1,
      proposed_body: "# 概要\n更新後の本文です。",
      reason: "typo fix",
      source: [],
    });
    const archiveProposal = reviews.createArchiveRecommendation({ note_id: "note_aa3", reason: "obsolete" });

    const result = reviews.approve(archiveProposal.proposal.id);
    expect(result.cascadedNeedsRebase).toEqual([updateProposal.proposal.id]);

    const item = reviews.getReviewItem(updateProposal.proposal.id);
    expect(item.status).toBe("needs_rebase");
  });

  it("cascades other pending archive_recommendation proposals on the same note to needs_rebase", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_aa4", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const first = reviews.createArchiveRecommendation({ note_id: "note_aa4", reason: "reason A" });
    const second = reviews.createArchiveRecommendation({ note_id: "note_aa4", reason: "reason B" });

    const result = reviews.approve(first.proposal.id);
    expect(result.cascadedNeedsRebase).toEqual([second.proposal.id]);
  });

  it("refuses to approve an archive_recommendation whose note is already archived (archived_target)", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_aa5", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_aa5", reason: "obsolete" });

    // Note gets archived out-of-band (e.g. via `kahanyaku archive` on the CLI) before this
    // recommendation is reviewed.
    ctx.db.prepare("UPDATE notes SET status = 'archived', archived_at = ? WHERE id = ?").run(new Date().toISOString(), "note_aa5");

    const err = captureError(() => reviews.approve(proposal.id));
    expect(err.code).toBe("archived_target");
  });

  it("refuses to re-approve an already-approved archive_recommendation", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_aa6", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_aa6", reason: "obsolete" });
    reviews.approve(proposal.id);

    expect(() => reviews.approve(proposal.id)).toThrow(KahanyakuError);
  });
});

describe("reject - archive_recommendation", () => {
  it("rejects the recommendation, leaving the note verified", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_ar_rej1", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_ar_rej1", reason: "obsolete?" });

    const result = reviews.reject(proposal.id, "still relevant, keep it");
    expect(result.status).toBe("rejected");
    expect(result.proposal?.status).toBe("rejected");

    const noteRow = ctx.db.prepare("SELECT status FROM notes WHERE id = ?").get("note_ar_rej1") as { status: string };
    expect(noteRow.status).toBe("verified");
  });
});

describe("reverse cascade: approving a normal update proposal needs_rebases pending archive_recommendations", () => {
  it("marks a pending archive_recommendation as needs_rebase when a sibling update proposal is approved", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_rc1", status: "verified", version: 1, body: "# 概要\n古い本文" });
    const reviews = createReviewService(ctx);
    const archiveProposal = reviews.createArchiveRecommendation({ note_id: "note_rc1", reason: "maybe obsolete" });
    const updateProposal = reviews.createProposal({
      id: "note_rc1",
      base_note_version: 1,
      proposed_body: "# 概要\n更新後の本文です。",
      reason: "actually just needs an update",
      source: [],
    });

    const result = reviews.approve(updateProposal.proposal.id);
    expect(result.cascadedNeedsRebase).toEqual([archiveProposal.proposal.id]);

    const item = reviews.getReviewItem(archiveProposal.proposal.id);
    expect(item.status).toBe("needs_rebase");
  });
});

describe("listReviewItems / getReviewItem expose proposalType", () => {
  it("listReviewItems includes proposalType and a distinct title for archive_recommendation", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_lp1", status: "verified", version: 1, title: "旧料金FAQ" });
    const reviews = createReviewService(ctx);
    reviews.createArchiveRecommendation({ note_id: "note_lp1", reason: "obsolete" });

    const { items } = reviews.listReviewItems({ kind: "proposal" });
    expect(items).toHaveLength(1);
    expect(items[0].proposalType).toBe("archive_recommendation");
    expect(items[0].title).toContain("Archive recommendation");
    expect(items[0].title).toContain("旧料金FAQ");
  });

  it("a normal update proposal's title still reads 'Update: ...' and proposalType is 'update'", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_lp2", status: "verified", version: 1, title: "現行ガイド" });
    const reviews = createReviewService(ctx);
    reviews.createProposal({ id: "note_lp2", base_note_version: 1, proposed_body: "# 概要\n更新", reason: "fix", source: [] });

    const { items } = reviews.listReviewItems({ kind: "proposal" });
    expect(items[0].proposalType).toBe("update");
    expect(items[0].title).toBe("Update: 現行ガイド");
  });

  it("getReviewItem exposes proposalType for an archive_recommendation", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_gp1", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_gp1", reason: "obsolete" });

    const item = reviews.getReviewItem(proposal.id);
    expect(item.proposalType).toBe("archive_recommendation");
    expect(item.reason).toBe("obsolete");
    expect(item.diff).toBe("");
  });

  it("getReviewItem's suggestedAction for a needs_rebase archive_recommendation mentions checking note status", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_gp2", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_gp2", reason: "obsolete" });
    ctx.db.prepare("UPDATE update_proposals SET status='needs_rebase' WHERE id=?").run(proposal.id);

    const item = reviews.getReviewItem(proposal.id);
    expect(item.suggestedAction).toContain("recommend_archive");
  });
});
