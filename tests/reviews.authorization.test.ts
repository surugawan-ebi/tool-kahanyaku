import { describe, it, expect } from "vitest";
import { createReviewService } from "../src/core/reviews.js";
import { createNoteService } from "../src/core/notes.js";
import { CiteHankoError } from "../src/core/errors.js";
import { computeConfigHash } from "../src/config/config.js";
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

function historyMetadata(ctx: AppContext, entityId: string, eventType: string): Record<string, unknown> {
  const row = ctx.db
    .prepare("SELECT metadata_json FROM history_events WHERE entity_id = ? AND event_type = ?")
    .get(entityId, eventType) as { metadata_json: string } | undefined;
  if (!row) throw new Error(`no ${eventType} history event found for ${entityId}`);
  return JSON.parse(row.metadata_json);
}

describe("scope_reviewers enforcement on approve (draft note)", () => {
  it("warn mode (default): a non-scope-reviewer can still approve, with a policy_warning", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { scopes: { support: { description: "", owners: [], reviewers: ["someone-else"] } } },
    });
    insertNoteFixture(ctx, { id: "note_1", status: "draft", scope: "support", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    const result = reviews.approve("note_1");
    expect(result.note.status).toBe("verified");
    expect(result.policyWarnings.map((w) => w.code)).toContain("not_scope_reviewer");
  });

  it("enforce mode: a non-reviewer, non-maintainer actor is rejected with policy_violation and no state change", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { scope_reviewers: "enforce", scopes: { support: { description: "", owners: [], reviewers: ["someone-else"] } } },
    });
    insertNoteFixture(ctx, { id: "note_2", status: "draft", scope: "support", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.approve("note_2"));
    expect(err.code).toBe("policy_violation");

    const row = ctx.db.prepare("SELECT status FROM notes WHERE id = ?").get("note_2") as { status: string };
    expect(row.status).toBe("draft");
  });

  it("enforce mode: a listed scope reviewer can approve without triggering bypass", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { scope_reviewers: "enforce", scopes: { support: { description: "", owners: [], reviewers: ["reviewer:human"] } } },
    });
    insertNoteFixture(ctx, { id: "note_3", status: "draft", scope: "support", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    reviews.approve("note_3");
    const metadata = historyMetadata(ctx, "note_3", "note_verified");
    expect(metadata.scope_reviewer_bypass).toBeUndefined();
    expect(metadata.config_hash).toBe(computeConfigHash(ctx.config));
  });

  it("enforce mode: a maintainer can approve as a break-glass bypass, recorded in history metadata", () => {
    const ctx = makeTestContext({
      actor: "maintainer:alice",
      role: "maintainer",
      config: { scope_reviewers: "enforce", scopes: { support: { description: "", owners: [], reviewers: ["someone-else"] } } },
    });
    insertNoteFixture(ctx, { id: "note_4", status: "draft", scope: "support", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    const result = reviews.approve("note_4");
    expect(result.note.status).toBe("verified");

    const metadata = historyMetadata(ctx, "note_4", "note_verified");
    expect(metadata.scope_reviewer_bypass).toBe(true);
    expect(metadata.config_hash).toBe(computeConfigHash(ctx.config));
  });

  it("enforce mode: rejects a non-maintainer for a note with no scope set at all", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { scope_reviewers: "enforce" },
    });
    insertNoteFixture(ctx, { id: "note_5", status: "draft", scope: null, createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.approve("note_5"));
    expect(err.code).toBe("policy_violation");
  });
});

describe("scope_reviewers enforcement on approve (update proposal and archive recommendation)", () => {
  it("enforce mode rejects a non-reviewer approving an update proposal, before any content is applied", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { scope_reviewers: "enforce", scopes: { support: { description: "", owners: [], reviewers: ["someone-else"] } } },
    });
    insertNoteFixture(ctx, { id: "note_p1", status: "verified", scope: "support", version: 1, body: "# 概要\n古い本文" });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal({
      id: "note_p1",
      base_note_version: 1,
      proposed_body: "# 概要\n更新後の本文です。",
      reason: "typo fix",
      source: [],
    });

    const err = captureError(() => reviews.approve(proposal.id));
    expect(err.code).toBe("policy_violation");

    const row = ctx.db.prepare("SELECT body, version FROM notes WHERE id = ?").get("note_p1") as { body: string; version: number };
    expect(row.body).toContain("古い本文");
    expect(row.version).toBe(1);
  });

  it("enforce mode rejects a non-reviewer approving an archive_recommendation, before the note is archived", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { scope_reviewers: "enforce", scopes: { support: { description: "", owners: [], reviewers: ["someone-else"] } } },
    });
    insertNoteFixture(ctx, { id: "note_p2", status: "verified", scope: "support", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_p2", reason: "obsolete" });

    const err = captureError(() => reviews.approve(proposal.id));
    expect(err.code).toBe("policy_violation");

    const row = ctx.db.prepare("SELECT status FROM notes WHERE id = ?").get("note_p2") as { status: string };
    expect(row.status).toBe("verified");
  });

  it("maintainer bypass on an archive_recommendation approval is recorded on both the note_archived and proposal_approved events", () => {
    const ctx = makeTestContext({
      actor: "maintainer:alice",
      role: "maintainer",
      config: { scope_reviewers: "enforce", scopes: { support: { description: "", owners: [], reviewers: ["someone-else"] } } },
    });
    insertNoteFixture(ctx, { id: "note_p3", status: "verified", scope: "support", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createArchiveRecommendation({ note_id: "note_p3", reason: "obsolete" });

    reviews.approve(proposal.id);

    expect(historyMetadata(ctx, "note_p3", "note_archived").scope_reviewer_bypass).toBe(true);
    expect(historyMetadata(ctx, proposal.id, "proposal_approved").scope_reviewer_bypass).toBe(true);
  });
});

describe("reviewer_separation:enforce", () => {
  it("rejects the author approving their own draft, even as a maintainer (no bypass for this one)", () => {
    const ctx = makeTestContext({
      actor: "agent:codex",
      role: "maintainer",
      config: { reviewer_separation: "enforce" },
    });
    insertNoteFixture(ctx, { id: "note_r1", status: "draft", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    const err = captureError(() => reviews.approve("note_r1"));
    expect(err.code).toBe("policy_violation");
  });

  it("does not affect approval by a different actor", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { reviewer_separation: "enforce" },
    });
    insertNoteFixture(ctx, { id: "note_r2", status: "draft", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    const result = reviews.approve("note_r2");
    expect(result.note.status).toBe("verified");
  });

  it("does not affect reject (only approve is authorization-checked)", () => {
    const ctx = makeTestContext({
      actor: "agent:codex",
      role: "contributor",
      config: { reviewer_separation: "enforce" },
    });
    insertNoteFixture(ctx, { id: "note_r3", status: "draft", createdBy: "agent:codex" });
    const reviews = createReviewService(ctx);

    expect(() => reviews.reject("note_r3", "not needed")).not.toThrow();
  });
});

describe("config_hash on approve/reject/archive history events", () => {
  it("records config_hash on note_rejected and proposal_rejected", () => {
    const ctx = makeTestContext({ actor: "reviewer:human" });
    insertNoteFixture(ctx, { id: "note_c1", status: "draft" });
    insertNoteFixture(ctx, { id: "note_c2", status: "verified", version: 1 });
    const reviews = createReviewService(ctx);
    const { proposal } = reviews.createProposal({
      id: "note_c2",
      base_note_version: 1,
      proposed_body: "# 概要\n更新後の本文です。",
      reason: "fix",
      source: [],
    });

    reviews.reject("note_c1", "no");
    reviews.reject(proposal.id, "no");

    expect(historyMetadata(ctx, "note_c1", "note_rejected").config_hash).toBe(computeConfigHash(ctx.config));
    expect(historyMetadata(ctx, proposal.id, "proposal_rejected").config_hash).toBe(computeConfigHash(ctx.config));
  });

  it("records config_hash on a direct CLI-style archive (notes.archiveNote), without scope-reviewer enforcement", () => {
    const ctx = makeTestContext({
      actor: "reviewer:human",
      role: "reviewer",
      config: { scope_reviewers: "enforce", scopes: { support: { description: "", owners: [], reviewers: ["someone-else"] } } },
    });
    insertNoteFixture(ctx, { id: "note_c3", status: "verified", scope: "support", version: 1 });
    const notes = createNoteService(ctx);

    // Direct archive is intentionally not gated by scope_reviewers (the coordinator's spec
    // scopes that enforcement to "approve" only) -- this must succeed even though
    // reviewer:human isn't a configured reviewer for "support".
    const note = notes.archiveNote("note_c3", "no longer needed");
    expect(note.status).toBe("archived");
    expect(historyMetadata(ctx, "note_c3", "note_archived").config_hash).toBe(computeConfigHash(ctx.config));
  });

  it("config_hash changes when the effective config changes", () => {
    const ctxA = makeTestContext({ actor: "reviewer:human", config: { default_review_interval_days: 30 } });
    const ctxB = makeTestContext({ actor: "reviewer:human", config: { default_review_interval_days: 60 } });
    expect(computeConfigHash(ctxA.config)).not.toBe(computeConfigHash(ctxB.config));
  });
});
