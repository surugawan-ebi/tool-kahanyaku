import type { AppContext } from "./context.js";
import type { CiteHankoConfig } from "../config/config.js";
import { CiteHankoError } from "./errors.js";
import type { Confidence } from "../types/common.js";
import type { PolicyWarning } from "../types/policy.js";

const SUMMARY_MIN_CHARS = 20;
// A note is expected to read like a small doc (see spec.md Note Granularity);
// fewer than this many markdown headings counts as "insufficient" structure.
const MIN_HEADINGS = 2;
const HEADING_PATTERN = /^#{1,6}\s+\S/m;

export interface DraftPolicyInput {
  summary: string;
  body: string;
  tags: string[];
  confidence: Confidence;
  sources: Array<{ type: string }>;
}

/**
 * Everything checkApprove needs about the thing being approved, already
 * resolved to its "effective" (post-approval) values by the caller (reviews.ts):
 * - draft note approval: the draft's own fields.
 * - proposal approval: proposed_* merged over the current verified note
 *   (there is no proposed_owner, so owner always comes from the note).
 */
export interface ApprovePolicyInput {
  kind: "note" | "proposal";
  /** created_by for a draft note, proposed_by for a proposal (reviewer_separation check). */
  authorActor: string;
  confidence: Confidence;
  owner: string | null;
  sources: Array<{ type: string }>;
  /** Only meaningful for proposal targets: the note's review_due_at before this approval. */
  noteReviewDueAt?: string | null;
  /** The target note's scope (scope_reviewers check). */
  scope: string | null;
}

/** Result of assertApprovalAuthorized: whether this approval only went through because a
 *  maintainer used their scope_reviewers break-glass bypass (see reviews.ts, which records
 *  this on the resulting history event's metadata as scope_reviewer_bypass: true). */
export interface AuthorizationResult {
  scopeReviewerBypass: boolean;
}

export interface PolicyService {
  checkDraft(note: DraftPolicyInput): PolicyWarning[];
  checkApprove(target: ApprovePolicyInput): PolicyWarning[];
  /**
   * Enforces (throws policy_violation, does not just warn) reviewer_separation: "enforce"
   * and scope_reviewers: "enforce". Call this before opening any write transaction, the same
   * way the existing base_note_version pre-check works, so a rejection never leaves partial
   * state. In "warn" mode (the default for both settings) this never throws -- the
   * corresponding policy_warnings from checkApprove are the only signal.
   */
  assertApprovalAuthorized(input: { authorActor: string; scope: string | null }): AuthorizationResult;
  computeReviewDueAt(verifiedAt: string): string;
}

/** True when `actor` is NOT an authorized reviewer for `scope`: no scope, no reviewers
 *  configured for that scope, or reviewers configured but actor isn't one of them. Shared
 *  by checkApprove's not_scope_reviewer warning and assertApprovalAuthorized's enforcement
 *  so the two conditions can never drift apart. */
function violatesScopeReviewer(scope: string | null, actor: string, config: CiteHankoConfig): boolean {
  const reviewers = scope ? (config.scopes[scope]?.reviewers ?? []) : [];
  return reviewers.length === 0 || !reviewers.includes(actor);
}

function weakSourceWarning(confidence: Confidence, sources: Array<{ type: string }>): PolicyWarning | null {
  if (confidence === "high" && sources.length > 0 && sources.every((s) => s.type === "manual")) {
    return {
      code: "weak_source_for_high_confidence",
      message: "confidence is high but all sources are manual",
      suggested_action: "add a stronger source (url/file/github/openwiki) or lower confidence",
    };
  }
  return null;
}

export function createPolicyService(ctx: AppContext): PolicyService {
  const { config } = ctx;

  return {
    checkDraft(note: DraftPolicyInput): PolicyWarning[] {
      const warnings: PolicyWarning[] = [];

      if (note.sources.length === 0) {
        warnings.push({
          code: "missing_source",
          message: "source is missing",
          suggested_action: "add at least one source before review",
        });
      }

      if (note.body.length > config.note_body_max_chars) {
        warnings.push({
          code: "body_too_long",
          message: `body exceeds ${config.note_body_max_chars} characters`,
          suggested_action: "split this note into smaller, single-topic notes",
        });
      }

      const headingCount = note.body.match(new RegExp(HEADING_PATTERN, "gm"))?.length ?? 0;
      if (headingCount < MIN_HEADINGS) {
        warnings.push({
          code: "missing_headings",
          message: "body has no or insufficient heading structure",
          suggested_action: "add markdown headings (e.g. # 概要, # 正本回答) to structure the note",
        });
      }

      if (note.summary.length < SUMMARY_MIN_CHARS) {
        warnings.push({
          code: "summary_too_short",
          message: `summary is shorter than ${SUMMARY_MIN_CHARS} characters`,
          suggested_action: "expand the summary so an AI can grasp the note without reading the body",
        });
      }

      if (note.tags.length === 0) {
        warnings.push({
          code: "tags_too_sparse",
          message: "no tags set",
          suggested_action: "add at least one tag to help search and scoping",
        });
      }

      const weakSource = weakSourceWarning(note.confidence, note.sources);
      if (weakSource) warnings.push(weakSource);

      return warnings;
    },

    checkApprove(target: ApprovePolicyInput): PolicyWarning[] {
      const warnings: PolicyWarning[] = [];
      const required = new Set(config.required_fields_for_verify);

      if (required.has("source") && target.sources.length === 0) {
        warnings.push({
          code: "missing_source",
          message: "source is missing",
          suggested_action: "add at least one source before approving",
        });
      }

      if (required.has("owner") && !target.owner) {
        warnings.push({
          code: "missing_owner",
          message: "owner is not set",
          suggested_action: "set an owner before approving",
        });
      }

      // "confidence" can be in required_fields_for_verify, but the column is
      // NOT NULL DEFAULT 'medium' (see migrations.ts), so it can never actually
      // be missing -- there is nothing to warn about here.

      if (target.authorActor === ctx.actor) {
        warnings.push({
          code: "reviewer_separation",
          message: `${ctx.actor} is both the author and the approver`,
          suggested_action: "have a different reviewer approve this change",
        });
      }

      if (violatesScopeReviewer(target.scope, ctx.actor, config)) {
        warnings.push({
          code: "not_scope_reviewer",
          message: `${ctx.actor} is not a configured reviewer for scope ${target.scope ?? "(none)"}`,
          suggested_action: "have a reviewer listed in scopes.<scope>.reviewers approve this change, or use a maintainer",
        });
      }

      const weakSource = weakSourceWarning(target.confidence, target.sources);
      if (weakSource) warnings.push(weakSource);

      if (target.kind === "proposal" && target.noteReviewDueAt && target.noteReviewDueAt < new Date().toISOString()) {
        warnings.push({
          code: "stale_note",
          message: "the note being updated is already past its review_due_at",
          suggested_action: "confirm the note content is still accurate while reviewing this change",
        });
      }

      return warnings;
    },

    assertApprovalAuthorized(input: { authorActor: string; scope: string | null }): AuthorizationResult {
      if (config.reviewer_separation === "enforce" && input.authorActor === ctx.actor) {
        throw new CiteHankoError(
          "policy_violation",
          `${ctx.actor} is both the author and the approver; reviewer_separation is set to "enforce"`,
          {
            details: { author_actor: input.authorActor, actor: ctx.actor },
            suggested_action: "have a different reviewer approve this change",
          },
        );
      }

      if (!violatesScopeReviewer(input.scope, ctx.actor, config)) {
        return { scopeReviewerBypass: false };
      }
      if (config.scope_reviewers !== "enforce") {
        return { scopeReviewerBypass: false };
      }
      if (ctx.role === "maintainer") {
        // break-glass: not a listed reviewer for this scope, but a maintainer can still
        // approve. Caller records this on the resulting history event's metadata.
        return { scopeReviewerBypass: true };
      }

      throw new CiteHankoError(
        "policy_violation",
        `${ctx.actor} is not a configured reviewer for scope ${input.scope ?? "(none)"}; scope_reviewers is set to "enforce"`,
        {
          details: { scope: input.scope, actor: ctx.actor, role: ctx.role },
          suggested_action: "have a reviewer listed in scopes.<scope>.reviewers approve this, or have a maintainer approve it",
        },
      );
    },

    computeReviewDueAt(verifiedAt: string): string {
      return computeReviewDueAt(verifiedAt, config.default_review_interval_days);
    },
  };
}

export function computeReviewDueAt(verifiedAt: string, intervalDays: number): string {
  const base = new Date(verifiedAt);
  base.setUTCDate(base.getUTCDate() + intervalDays);
  return base.toISOString();
}
