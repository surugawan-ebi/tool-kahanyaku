import type { AppContext } from "./context.js";
import { newId } from "./ids.js";
import { CiteHankoError, parseOrThrow } from "./errors.js";
import { createHistoryService } from "./history.js";
import { createPolicyService } from "./policy.js";
import { computeConfigHash } from "../config/config.js";
import { buildUnifiedDiff, changedFields } from "./diff.js";
import { buildSearchText } from "./searchText.js";
import {
  getNoteRow,
  getTags,
  getSources,
  replaceTags,
  appendSources,
  buildNoteSnapshot,
  rowToNote,
  type NoteRow,
} from "./noteRows.js";
import {
  ProposeUpdateInput,
  RecommendArchiveInput,
  type Proposal,
  type CreateProposalResult,
  type ApproveResult,
  type RejectResult,
  type ReviewItem,
  type ReviewItemFilter,
  type ReviewItemDetail,
  type ListReviewItemsResult,
} from "../types/proposal.js";
import type { PolicyWarning } from "../types/policy.js";
import type { Confidence, ProposalType, SourceInput } from "../types/common.js";

/** Default page size for listReviewItems when the caller doesn't specify one. */
const DEFAULT_LIST_REVIEW_ITEMS_LIMIT = 20;

/** review plane normalization: a draft note reads as "pending_review" so it's
 *  filterable/comparable the same way as a proposal (see types/proposal.ts). */
function normalizeNoteReviewStatus(rawStatus: string): string {
  return rawStatus === "draft" ? "pending_review" : rawStatus;
}

/** Inverse of normalizeNoteReviewStatus, for translating an incoming status filter into
 *  the raw notes.status value. undefined means "no note can have this normalized status"
 *  (e.g. "needs_rebase" only ever applies to proposals). */
const NOTE_RAW_STATUS_BY_NORMALIZED: Record<string, string | undefined> = {
  pending_review: "draft",
  rejected: "rejected",
};

/** Signals "the compound version+status WHERE clause matched 0 rows" from inside a
 *  db.transaction() callback, so the transaction rolls back and the caller can fall
 *  back to the needs_rebase path with an accurate (freshly re-read) current version. */
class ApproveVersionMismatch extends Error {}

interface ProposalRow {
  id: string;
  note_id: string;
  status: string;
  proposal_type: string;
  base_note_version: number;
  proposed_title: string | null;
  proposed_summary: string | null;
  proposed_body: string | null;
  proposed_tags_json: string | null;
  proposed_scope: string | null;
  proposed_confidence: string | null;
  diff: string;
  changed_fields_json: string;
  reason: string;
  source_json: string;
  proposed_by: string;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
  rejection_reason: string | null;
}

function rowToProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    noteId: row.note_id,
    status: row.status as Proposal["status"],
    proposalType: row.proposal_type as Proposal["proposalType"],
    baseNoteVersion: row.base_note_version,
    proposedTitle: row.proposed_title,
    proposedSummary: row.proposed_summary,
    proposedBody: row.proposed_body,
    proposedTags: row.proposed_tags_json ? JSON.parse(row.proposed_tags_json) : null,
    proposedScope: row.proposed_scope,
    proposedConfidence: row.proposed_confidence as Proposal["proposedConfidence"],
    diff: row.diff,
    changedFields: JSON.parse(row.changed_fields_json),
    reason: row.reason,
    source: JSON.parse(row.source_json),
    proposedBy: row.proposed_by,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
  };
}

/** Renders a note (or a note with a proposal's changes applied) as one document for buildUnifiedDiff. */
function noteDiffText(fields: { title: string; summary: string; body: string; tags: string[] }): string {
  return `# ${fields.title}\n\n${fields.summary}\n\ntags: ${fields.tags.join(", ")}\n\n${fields.body}\n`;
}

export interface ReviewService {
  createProposal(input: ProposeUpdateInput): CreateProposalResult;
  createArchiveRecommendation(input: RecommendArchiveInput): CreateProposalResult;
  approve(targetId: string, reason?: string): ApproveResult;
  reject(targetId: string, reason: string): RejectResult;
  listReviewItems(filter: ReviewItemFilter): ListReviewItemsResult;
  getReviewItem(id: string): ReviewItemDetail;
}

export function createReviewService(ctx: AppContext): ReviewService {
  const { db, actor, role, config } = ctx;
  const history = createHistoryService(ctx);
  const policy = createPolicyService(ctx);

  /** {config_hash} or {config_hash, scope_reviewer_bypass:true}, for approve/reject/archive
   *  history event metadata (see wall-discussion.md #15). */
  function decisionMetadata(scopeReviewerBypass: boolean): Record<string, unknown> {
    const configHash = computeConfigHash(config);
    return scopeReviewerBypass ? { config_hash: configHash, scope_reviewer_bypass: true } : { config_hash: configHash };
  }

  function requireNoteRow(id: string): NoteRow {
    const row = getNoteRow(db, id);
    if (!row) throw new CiteHankoError("not_found", `${id} was not found`, { details: { id } });
    return row;
  }

  function getProposalRow(id: string): ProposalRow | undefined {
    return db.prepare("SELECT * FROM update_proposals WHERE id = ?").get(id) as ProposalRow | undefined;
  }

  function requireProposalRow(id: string): ProposalRow {
    const row = getProposalRow(id);
    if (!row) throw new CiteHankoError("not_found", `${id} was not found`, { details: { id } });
    return row;
  }

  /** proposed_* merged over the current note; used for diff text, policy checks and applying the approval. */
  function effectiveProposalFields(note: NoteRow, tags: string[], proposal: ProposalRow) {
    return {
      title: proposal.proposed_title ?? note.title,
      summary: proposal.proposed_summary ?? note.summary,
      body: proposal.proposed_body ?? note.body,
      tags: proposal.proposed_tags_json ? (JSON.parse(proposal.proposed_tags_json) as string[]) : tags,
      scope: proposal.proposed_scope ?? note.scope,
      confidence: (proposal.proposed_confidence ?? note.confidence) as string,
    };
  }

  function proposalPolicyWarnings(note: NoteRow, tags: string[], proposal: ProposalRow): PolicyWarning[] {
    const effective = effectiveProposalFields(note, tags, proposal);
    const sources = JSON.parse(proposal.source_json) as Array<{ type: string }>;
    return policy.checkDraft({
      summary: effective.summary,
      body: effective.body,
      tags: effective.tags,
      confidence: effective.confidence as Confidence,
      sources,
    });
  }

  return {
    createProposal(rawInput: ProposeUpdateInput): CreateProposalResult {
      const input = parseOrThrow(ProposeUpdateInput, rawInput);
      const note = requireNoteRow(input.id);

      if (note.status === "archived") {
        throw new CiteHankoError("archived_target", `${input.id} is archived and cannot receive proposals`, {
          details: { status: note.status },
        });
      }
      if (note.status !== "verified") {
        throw new CiteHankoError(
          "invalid_input",
          `${input.id} is ${note.status}, not verified. Only verified notes can receive update proposals.`,
          { details: { status: note.status }, suggested_action: "use update_draft for draft/rejected notes" },
        );
      }
      if (input.base_note_version !== note.version) {
        throw new CiteHankoError(
          "version_conflict",
          `base_note_version ${input.base_note_version} does not match the current version ${note.version}`,
          {
            details: { base_note_version: input.base_note_version, current_version: note.version },
            retryable: true,
            suggested_action: "fetch the current note and resubmit with the latest version",
          },
        );
      }

      const currentTags = getTags(db, note.id);
      const changed = changedFields(
        {
          title: input.proposed_title,
          summary: input.proposed_summary,
          body: input.proposed_body,
          tags: input.proposed_tags,
          scope: input.proposed_scope,
          confidence: input.proposed_confidence,
        },
        {
          title: note.title,
          summary: note.summary,
          body: note.body,
          tags: currentTags,
          scope: note.scope,
          confidence: note.confidence,
        },
      );

      if (changed.length === 0) {
        throw new CiteHankoError("empty_change", "no fields were changed by this proposal", {
          suggested_action: "modify at least one field before proposing an update",
        });
      }

      const proposedTags = input.proposed_tags ?? currentTags;
      const diff = buildUnifiedDiff(
        noteDiffText({ title: note.title, summary: note.summary, body: note.body, tags: currentTags }),
        noteDiffText({
          title: input.proposed_title ?? note.title,
          summary: input.proposed_summary ?? note.summary,
          body: input.proposed_body ?? note.body,
          tags: proposedTags,
        }),
        note.slug,
      );

      const policyWarnings = policy.checkDraft({
        summary: input.proposed_summary ?? note.summary,
        body: input.proposed_body ?? note.body,
        tags: proposedTags,
        confidence: (input.proposed_confidence ?? note.confidence) as Confidence,
        sources: input.source,
      });

      const id = newId("proposal");
      const now = new Date().toISOString();

      const runCreate = db.transaction(() => {
        const row: ProposalRow = {
          id,
          note_id: note.id,
          status: "pending_review",
          proposal_type: "update",
          base_note_version: input.base_note_version,
          proposed_title: input.proposed_title ?? null,
          proposed_summary: input.proposed_summary ?? null,
          proposed_body: input.proposed_body ?? null,
          proposed_tags_json: input.proposed_tags ? JSON.stringify(input.proposed_tags) : null,
          proposed_scope: input.proposed_scope ?? null,
          proposed_confidence: input.proposed_confidence ?? null,
          diff,
          changed_fields_json: JSON.stringify(changed),
          reason: input.reason,
          source_json: JSON.stringify(input.source),
          proposed_by: actor,
          reviewed_by: null,
          created_at: now,
          reviewed_at: null,
          rejection_reason: null,
        };
        db.prepare(
          `INSERT INTO update_proposals
             (id, note_id, status, proposal_type, base_note_version, proposed_title, proposed_summary,
              proposed_body, proposed_tags_json, proposed_scope, proposed_confidence, diff,
              changed_fields_json, reason, source_json, proposed_by, reviewed_by, created_at,
              reviewed_at, rejection_reason)
           VALUES
             (@id, @note_id, @status, @proposal_type, @base_note_version, @proposed_title, @proposed_summary,
              @proposed_body, @proposed_tags_json, @proposed_scope, @proposed_confidence, @diff,
              @changed_fields_json, @reason, @source_json, @proposed_by, @reviewed_by, @created_at,
              @reviewed_at, @rejection_reason)`,
        ).run(row);

        history.record({
          entityType: "proposal",
          entityId: id,
          eventType: "proposal_created",
          actor,
          role,
          scope: note.scope,
          reason: input.reason,
          afterSnapshot: { proposal: row },
        });

        return rowToProposal(row);
      });

      return { proposal: runCreate(), policyWarnings };
    },

    createArchiveRecommendation(rawInput: RecommendArchiveInput): CreateProposalResult {
      const input = parseOrThrow(RecommendArchiveInput, rawInput);
      const note = requireNoteRow(input.note_id);

      if (note.status === "archived") {
        throw new CiteHankoError("archived_target", `${input.note_id} is already archived`, {
          details: { status: note.status },
        });
      }
      if (note.status !== "verified") {
        throw new CiteHankoError(
          "not_verified",
          `${input.note_id} is ${note.status}, not verified. Only verified notes can receive an archive recommendation.`,
          { details: { status: note.status }, suggested_action: "use update_draft/get_review_item for draft/rejected notes" },
        );
      }

      const id = newId("proposal");
      const now = new Date().toISOString();

      const runCreate = db.transaction(() => {
        // No content change: proposed_* stays null, diff is empty, changed_fields is [].
        // The recommendation's substance lives entirely in `reason`.
        const row: ProposalRow = {
          id,
          note_id: note.id,
          status: "pending_review",
          proposal_type: "archive_recommendation",
          base_note_version: note.version,
          proposed_title: null,
          proposed_summary: null,
          proposed_body: null,
          proposed_tags_json: null,
          proposed_scope: null,
          proposed_confidence: null,
          diff: "",
          changed_fields_json: "[]",
          reason: input.reason,
          source_json: "[]",
          proposed_by: actor,
          reviewed_by: null,
          created_at: now,
          reviewed_at: null,
          rejection_reason: null,
        };
        db.prepare(
          `INSERT INTO update_proposals
             (id, note_id, status, proposal_type, base_note_version, proposed_title, proposed_summary,
              proposed_body, proposed_tags_json, proposed_scope, proposed_confidence, diff,
              changed_fields_json, reason, source_json, proposed_by, reviewed_by, created_at,
              reviewed_at, rejection_reason)
           VALUES
             (@id, @note_id, @status, @proposal_type, @base_note_version, @proposed_title, @proposed_summary,
              @proposed_body, @proposed_tags_json, @proposed_scope, @proposed_confidence, @diff,
              @changed_fields_json, @reason, @source_json, @proposed_by, @reviewed_by, @created_at,
              @reviewed_at, @rejection_reason)`,
        ).run(row);

        history.record({
          entityType: "proposal",
          entityId: id,
          eventType: "proposal_created",
          actor,
          role,
          scope: note.scope,
          reason: input.reason,
          afterSnapshot: { proposal: row },
        });

        return rowToProposal(row);
      });

      return { proposal: runCreate(), policyWarnings: [] };
    },

    approve(targetId: string, reason?: string): ApproveResult {
      if (targetId.startsWith("note_")) return approveNoteDraft(targetId, reason);
      if (targetId.startsWith("proposal_")) return approveProposal(targetId, reason);
      throw new CiteHankoError("not_found", `${targetId} was not found`, { details: { id: targetId } });
    },

    reject(targetId: string, reason: string): RejectResult {
      if (!reason) {
        throw new CiteHankoError("invalid_input", "reason is required to reject", {
          suggested_action: "provide a reason explaining the rejection",
        });
      }
      if (targetId.startsWith("note_")) return rejectNote(targetId, reason);
      if (targetId.startsWith("proposal_")) return rejectProposal(targetId, reason);
      throw new CiteHankoError("not_found", `${targetId} was not found`, { details: { id: targetId } });
    },

    listReviewItems(filter: ReviewItemFilter): ListReviewItemsResult {
      const createdByFilter = filter.createdBy === "self" ? actor : filter.createdBy;
      const items: ReviewItem[] = [];

      // A normalized status filter (e.g. "needs_rebase") may have no corresponding raw
      // notes.status at all; in that case the draft branch matches nothing and we skip
      // querying it entirely rather than running a query with a status clause that (by
      // coincidence) could match something it shouldn't.
      const draftRawStatus = filter.status ? NOTE_RAW_STATUS_BY_NORMALIZED[filter.status] : undefined;
      const draftBranchApplies = (!filter.kind || filter.kind === "draft") && (!filter.status || draftRawStatus);

      if (draftBranchApplies) {
        const clauses = ["status IN ('draft', 'rejected')"];
        const params: Record<string, unknown> = {};
        if (filter.scope) {
          clauses.push("scope = @scope");
          params.scope = filter.scope;
        }
        if (createdByFilter) {
          clauses.push("created_by = @createdBy");
          params.createdBy = createdByFilter;
        }
        if (draftRawStatus) {
          clauses.push("status = @status");
          params.status = draftRawStatus;
        }
        const rows = db.prepare(`SELECT * FROM notes WHERE ${clauses.join(" AND ")}`).all(params) as NoteRow[];
        for (const row of rows) {
          const tags = getTags(db, row.id);
          const sources = getSources(db, row.id).map((s) => ({ type: s.type }));
          const warnings = policy.checkDraft({
            summary: row.summary,
            body: row.body,
            tags,
            confidence: row.confidence as Confidence,
            sources,
          });
          const duplicates = (JSON.parse(row.metadata_json).possible_duplicates ?? []) as unknown[];
          items.push({
            id: row.id,
            kind: "draft",
            status: normalizeNoteReviewStatus(row.status),
            noteStatus: row.status,
            scope: row.scope,
            createdBy: row.created_by,
            createdAt: row.created_at,
            title: row.title,
            hasWarnings: warnings.length > 0,
            hasDuplicates: duplicates.length > 0,
          });
        }
      }

      if (!filter.kind || filter.kind === "proposal") {
        // Proposal status is already the review-plane vocabulary 1:1 (pending_review/
        // needs_rebase/rejected/approved), so filter.status passes straight through.
        const clauses = ["p.status IN ('pending_review', 'needs_rebase', 'rejected')"];
        const params: Record<string, unknown> = {};
        if (filter.scope) {
          clauses.push("n.scope = @scope");
          params.scope = filter.scope;
        }
        if (createdByFilter) {
          clauses.push("p.proposed_by = @createdBy");
          params.createdBy = createdByFilter;
        }
        if (filter.status) {
          clauses.push("p.status = @status");
          params.status = filter.status;
        }
        const rows = db
          .prepare(
            `SELECT p.*, n.scope AS note_scope, n.title AS note_title
               FROM update_proposals p JOIN notes n ON n.id = p.note_id
              WHERE ${clauses.join(" AND ")}`,
          )
          .all(params) as (ProposalRow & { note_scope: string | null; note_title: string })[];
        for (const row of rows) {
          const note = requireNoteRow(row.note_id);
          const tags = getTags(db, note.id);
          const warnings = proposalPolicyWarnings(note, tags, row);
          items.push({
            id: row.id,
            kind: "proposal",
            status: row.status,
            proposalType: row.proposal_type as ProposalType,
            scope: row.note_scope,
            createdBy: row.proposed_by,
            createdAt: row.created_at,
            title:
              row.proposal_type === "archive_recommendation"
                ? `Archive recommendation: ${row.note_title}`
                : `Update: ${row.note_title}`,
            hasWarnings: warnings.length > 0,
            hasDuplicates: false,
          });
        }
      }

      let sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (filter.cursor) {
        const idx = sorted.findIndex((i) => i.id === filter.cursor);
        if (idx >= 0) sorted = sorted.slice(idx + 1);
      }
      const limit = filter.limit ?? DEFAULT_LIST_REVIEW_ITEMS_LIMIT;
      const page = sorted.slice(0, limit);
      const nextCursor = page.length === limit && page.length > 0 ? page[page.length - 1].id : null;
      return { items: page, nextCursor };
    },

    getReviewItem(id: string): ReviewItemDetail {
      if (id.startsWith("note_")) {
        const note = requireNoteRow(id);
        const tags = getTags(db, note.id);
        const sources = getSources(db, note.id).map((s) => ({ type: s.type }));
        const policyWarnings = policy.checkDraft({
          summary: note.summary,
          body: note.body,
          tags,
          confidence: note.confidence as Confidence,
          sources,
        });
        return {
          id: note.id,
          kind: "note",
          status: normalizeNoteReviewStatus(note.status),
          noteStatus: note.status,
          usableAsContext: false,
          rejectionReason: note.rejection_reason,
          draftReason: note.draft_reason,
          policyWarnings,
          body: note.body,
        };
      }
      if (id.startsWith("proposal_")) {
        const proposal = requireProposalRow(id);
        const note = requireNoteRow(proposal.note_id);
        const tags = getTags(db, note.id);
        const detail: ReviewItemDetail = {
          id: proposal.id,
          kind: "proposal",
          status: proposal.status,
          proposalType: proposal.proposal_type as ProposalType,
          usableAsContext: false,
          rejectionReason: proposal.rejection_reason,
          policyWarnings: proposalPolicyWarnings(note, tags, proposal),
          targetNoteId: proposal.note_id,
          baseNoteVersion: proposal.base_note_version,
          currentNoteVersion: note.version,
          body: proposal.proposed_body ?? note.body,
          diff: proposal.diff,
          reason: proposal.reason,
          source: JSON.parse(proposal.source_json),
          proposedBy: proposal.proposed_by,
          changedFields: JSON.parse(proposal.changed_fields_json),
        };
        if (proposal.status === "needs_rebase") {
          detail.suggestedAction =
            proposal.proposal_type === "archive_recommendation"
              ? "the note is no longer verified; check its current status and resubmit recommend_archive if still applicable"
              : "fetch current note and resubmit";
        }
        return detail;
      }
      throw new CiteHankoError("not_found", `${id} was not found`, { details: { id } });
    },
  };

  function approveNoteDraft(id: string, reason?: string): ApproveResult {
    const note = requireNoteRow(id);
    if (note.status !== "draft") {
      throw new CiteHankoError("invalid_input", `${id} is ${note.status}; only draft notes can be approved`, {
        details: { status: note.status },
      });
    }

    const sources = getSources(db, note.id).map((s) => ({ type: s.type }));
    const policyWarnings = policy.checkApprove({
      kind: "note",
      authorActor: note.created_by,
      confidence: note.confidence as Confidence,
      owner: note.owner,
      sources,
      scope: note.scope,
    });
    const { scopeReviewerBypass } = policy.assertApprovalAuthorized({ authorActor: note.created_by, scope: note.scope });

    const now = new Date().toISOString();
    const metadata = decisionMetadata(scopeReviewerBypass);
    const runApprove = db.transaction(() => {
      const beforeSnapshot = buildNoteSnapshot(db, note);
      const reviewDueAt = policy.computeReviewDueAt(now);
      const updated: NoteRow = {
        ...note,
        status: "verified",
        version: note.version + 1,
        verified_at: now,
        review_due_at: reviewDueAt,
        reviewed_by: actor,
        updated_at: now,
      };
      db.prepare(
        `UPDATE notes SET status=@status, version=@version, verified_at=@verified_at, review_due_at=@review_due_at,
           reviewed_by=@reviewed_by, updated_at=@updated_at WHERE id=@id`,
      ).run(updated);
      history.record({
        entityType: "note",
        entityId: id,
        eventType: "note_verified",
        actor,
        role,
        scope: note.scope,
        reason: reason ?? null,
        beforeSnapshot,
        afterSnapshot: buildNoteSnapshot(db, updated),
        metadata,
      });
      return rowToNote(updated);
    });

    return { kind: "note", note: runApprove(), cascadedNeedsRebase: [], policyWarnings };
  }

  /**
   * Commits the needs_rebase transition on its own transaction (it must survive), THEN
   * throws version_conflict. A single transaction would roll this update back too when
   * the error propagates, since better-sqlite3 transactions rollback on throw.
   */
  function markNeedsRebaseAndThrow(proposal: ProposalRow, note: NoteRow, reason: string | undefined): never {
    const markNeedsRebase = db.transaction(() => {
      db.prepare("UPDATE update_proposals SET status='needs_rebase' WHERE id=?").run(proposal.id);
      history.record({
        entityType: "proposal",
        entityId: proposal.id,
        eventType: "proposal_needs_rebase",
        actor,
        role,
        scope: note.scope,
        reason: reason ?? null,
        beforeSnapshot: { proposal },
        afterSnapshot: { proposal: { ...proposal, status: "needs_rebase" } },
      });
    });
    markNeedsRebase();
    throw new CiteHankoError(
      "version_conflict",
      `proposal ${proposal.id} is based on version ${proposal.base_note_version} but the note is now at version ${note.version}`,
      {
        details: { base_note_version: proposal.base_note_version, current_version: note.version },
        retryable: true,
        suggested_action: "fetch the current note and resubmit propose_note_update",
      },
    );
  }

  /**
   * approve(targetId) for a proposal_* id: shared status check, then dispatches on
   * proposal_type. "update" applies proposed_* content changes to the note (the original
   * behavior); "archive_recommendation" has no content to apply and instead archives the
   * target note itself (see approveArchiveRecommendation).
   */
  function approveProposal(id: string, reason?: string): ApproveResult {
    const proposal = requireProposalRow(id);
    if (proposal.status !== "pending_review") {
      throw new CiteHankoError(
        "invalid_input",
        `${id} is ${proposal.status}; only pending_review proposals can be approved`,
        { details: { status: proposal.status }, suggested_action: "fetch current note and resubmit" },
      );
    }
    if (proposal.proposal_type === "archive_recommendation") {
      return approveArchiveRecommendation(proposal, reason);
    }
    return approveUpdateProposal(proposal, reason);
  }

  function approveUpdateProposal(proposal: ProposalRow, reason?: string): ApproveResult {
    const note = requireNoteRow(proposal.note_id);
    if (note.status === "archived") {
      throw new CiteHankoError("archived_target", `${proposal.note_id} is archived`, {
        details: { status: note.status },
      });
    }

    // Authorization is checked before the version pre-check below: an unauthorized actor
    // should be rejected outright, not steered toward a needs_rebase/version_conflict
    // response that implies "resubmit and it'll work".
    const { scopeReviewerBypass } = policy.assertApprovalAuthorized({ authorActor: proposal.proposed_by, scope: note.scope });

    // Cheap pre-check for the common case: skip building effective/policyWarnings and
    // opening a transaction when it's already obviously stale. This alone is NOT the
    // correctness guard (TOCTOU: another process -- e.g. the MCP server and a CLI
    // invocation sharing the same db file -- could bump the version between this read
    // and the transaction below), so it must produce the same result as the guarded
    // path if hit; the real guard is the compound WHERE clause inside runApprove.
    if (proposal.base_note_version !== note.version) {
      markNeedsRebaseAndThrow(proposal, note, reason);
    }

    const currentTags = getTags(db, note.id);
    const effective = effectiveProposalFields(note, currentTags, proposal);
    const proposalSources = JSON.parse(proposal.source_json) as SourceInput[];
    const policyWarnings = policy.checkApprove({
      kind: "proposal",
      authorActor: proposal.proposed_by,
      confidence: effective.confidence as Confidence,
      owner: note.owner,
      sources: proposalSources,
      noteReviewDueAt: note.review_due_at,
      scope: note.scope,
    });

    const now = new Date().toISOString();
    const metadata = decisionMetadata(scopeReviewerBypass);
    const runApprove = db.transaction(() => {
      const beforeSnapshot = buildNoteSnapshot(db, note);
      const reviewDueAt = policy.computeReviewDueAt(now);
      const updatedNote: NoteRow = {
        ...note,
        title: effective.title,
        summary: effective.summary,
        body: effective.body,
        scope: effective.scope,
        confidence: effective.confidence,
        version: note.version + 1,
        updated_at: now,
        verified_at: now,
        review_due_at: reviewDueAt,
        reviewed_by: actor,
        search_text: buildSearchText(effective.title, effective.summary, effective.body, effective.tags),
      };

      // The optimistic lock lives here, not in the pre-check above: only commit if the
      // row still has the version/status this proposal was created against. 0 rows
      // changed means someone else (possibly another process) got there first.
      const updateResult = db
        .prepare(
          `UPDATE notes SET title=@title, summary=@summary, body=@body, scope=@scope, confidence=@confidence,
             version=@version, updated_at=@updated_at, verified_at=@verified_at, review_due_at=@review_due_at,
             reviewed_by=@reviewed_by, search_text=@search_text
           WHERE id=@id AND version=@expectedVersion AND status='verified'`,
        )
        .run({ ...updatedNote, expectedVersion: proposal.base_note_version });

      if (updateResult.changes !== 1) {
        throw new ApproveVersionMismatch();
      }

      if (proposal.proposed_tags_json) replaceTags(db, note.id, effective.tags);
      appendSources(db, note.id, proposalSources);

      const updatedProposal: ProposalRow = { ...proposal, status: "approved", reviewed_by: actor, reviewed_at: now };
      db.prepare("UPDATE update_proposals SET status='approved', reviewed_by=@reviewed_by, reviewed_at=@reviewed_at WHERE id=@id").run(
        { id: proposal.id, reviewed_by: actor, reviewed_at: now },
      );

      history.record({
        entityType: "proposal",
        entityId: proposal.id,
        eventType: "proposal_approved",
        actor,
        role,
        scope: note.scope,
        reason: reason ?? null,
        beforeSnapshot: { proposal },
        afterSnapshot: { proposal: updatedProposal },
        metadata,
      });
      history.record({
        entityType: "note",
        entityId: note.id,
        eventType: "note_updated",
        actor,
        role,
        scope: note.scope,
        reason: reason ?? null,
        beforeSnapshot,
        afterSnapshot: buildNoteSnapshot(db, updatedNote),
        metadata,
      });

      const others = db
        .prepare("SELECT * FROM update_proposals WHERE note_id = ? AND status = 'pending_review' AND id != ?")
        .all(note.id, proposal.id) as ProposalRow[];
      const cascaded: string[] = [];
      for (const other of others) {
        db.prepare("UPDATE update_proposals SET status='needs_rebase' WHERE id=?").run(other.id);
        history.record({
          entityType: "proposal",
          entityId: other.id,
          eventType: "proposal_needs_rebase",
          actor,
          role,
          scope: note.scope,
          reason: `superseded by ${proposal.id}`,
          beforeSnapshot: { proposal: other },
          afterSnapshot: { proposal: { ...other, status: "needs_rebase" } },
        });
        cascaded.push(other.id);
      }

      return { note: rowToNote(updatedNote), proposal: rowToProposal(updatedProposal), cascaded };
    });

    let result: { note: import("../types/note.js").Note; proposal: Proposal; cascaded: string[] };
    try {
      result = runApprove();
    } catch (err) {
      if (err instanceof ApproveVersionMismatch) {
        // Another writer beat us between the pre-check and the transaction's commit;
        // re-read to report an accurate current_version, then follow the exact same
        // needs_rebase + version_conflict path as the pre-check above.
        const freshNote = requireNoteRow(proposal.note_id);
        markNeedsRebaseAndThrow(proposal, freshNote, reason);
      }
      throw err;
    }

    return {
      kind: "proposal",
      note: result.note,
      proposal: result.proposal,
      cascadedNeedsRebase: result.cascaded,
      policyWarnings,
    };
  }

  /**
   * needs_rebase fallback for an archive_recommendation whose target note is no longer
   * verified by the time it's approved (already archived by someone else, or -- in
   * principle -- otherwise moved off "verified"). Mirrors markNeedsRebaseAndThrow's
   * commit-then-throw shape, but the lock this proposal type cares about is note.status,
   * not note.version (there's no content to apply, so no version-based optimistic lock).
   */
  function markArchiveRecommendationNeedsRebaseAndThrow(proposal: ProposalRow, note: NoteRow, reason: string | undefined): never {
    const markNeedsRebase = db.transaction(() => {
      db.prepare("UPDATE update_proposals SET status='needs_rebase' WHERE id=?").run(proposal.id);
      history.record({
        entityType: "proposal",
        entityId: proposal.id,
        eventType: "proposal_needs_rebase",
        actor,
        role,
        scope: note.scope,
        reason: reason ?? null,
        beforeSnapshot: { proposal },
        afterSnapshot: { proposal: { ...proposal, status: "needs_rebase" } },
      });
    });
    markNeedsRebase();
    throw new CiteHankoError(
      "version_conflict",
      `archive recommendation ${proposal.id} cannot be applied: ${note.id} is no longer verified (current status: ${note.status})`,
      {
        details: { current_status: note.status },
        retryable: true,
        suggested_action: "check the note's current status via get_review_item; resubmit recommend_archive if it's verified again",
      },
    );
  }

  /**
   * Approving an archive_recommendation has no content to apply -- it archives the target
   * note itself. The optimistic lock is "note.status is still verified" (checked atomically
   * via the UPDATE's WHERE clause below), not a version match: an unrelated content update
   * approved in the meantime doesn't invalidate this recommendation, only the note no
   * longer being verified does. Cascades to other pending proposals on the same note
   * exactly like approveUpdateProposal does, since none of them can apply to an archived note.
   */
  function approveArchiveRecommendation(proposal: ProposalRow, reason?: string): ApproveResult {
    const note = requireNoteRow(proposal.note_id);
    if (note.status === "archived") {
      throw new CiteHankoError("archived_target", `${proposal.note_id} is already archived`, {
        details: { status: note.status },
      });
    }
    if (note.status !== "verified") {
      markArchiveRecommendationNeedsRebaseAndThrow(proposal, note, reason);
    }

    const { scopeReviewerBypass } = policy.assertApprovalAuthorized({ authorActor: proposal.proposed_by, scope: note.scope });

    const now = new Date().toISOString();
    const metadata = decisionMetadata(scopeReviewerBypass);
    const runApprove = db.transaction(() => {
      const beforeSnapshot = buildNoteSnapshot(db, note);
      const updatedNote: NoteRow = { ...note, status: "archived", archived_at: now, updated_at: now };

      const updateResult = db
        .prepare("UPDATE notes SET status='archived', archived_at=@archived_at, updated_at=@updated_at WHERE id=@id AND status='verified'")
        .run({ id: note.id, archived_at: now, updated_at: now });

      if (updateResult.changes !== 1) {
        throw new ApproveVersionMismatch();
      }

      const updatedProposal: ProposalRow = { ...proposal, status: "approved", reviewed_by: actor, reviewed_at: now };
      db.prepare("UPDATE update_proposals SET status='approved', reviewed_by=@reviewed_by, reviewed_at=@reviewed_at WHERE id=@id").run(
        { id: proposal.id, reviewed_by: actor, reviewed_at: now },
      );

      history.record({
        entityType: "note",
        entityId: note.id,
        eventType: "note_archived",
        actor,
        role,
        scope: note.scope,
        reason: reason ?? proposal.reason,
        beforeSnapshot,
        afterSnapshot: buildNoteSnapshot(db, updatedNote),
        metadata,
      });
      history.record({
        entityType: "proposal",
        entityId: proposal.id,
        eventType: "proposal_approved",
        actor,
        role,
        scope: note.scope,
        reason: reason ?? null,
        beforeSnapshot: { proposal },
        afterSnapshot: { proposal: updatedProposal },
        metadata,
      });

      const others = db
        .prepare("SELECT * FROM update_proposals WHERE note_id = ? AND status = 'pending_review' AND id != ?")
        .all(note.id, proposal.id) as ProposalRow[];
      const cascaded: string[] = [];
      for (const other of others) {
        db.prepare("UPDATE update_proposals SET status='needs_rebase' WHERE id=?").run(other.id);
        history.record({
          entityType: "proposal",
          entityId: other.id,
          eventType: "proposal_needs_rebase",
          actor,
          role,
          scope: note.scope,
          reason: `note archived via ${proposal.id}`,
          beforeSnapshot: { proposal: other },
          afterSnapshot: { proposal: { ...other, status: "needs_rebase" } },
        });
        cascaded.push(other.id);
      }

      return { note: rowToNote(updatedNote), proposal: rowToProposal(updatedProposal), cascaded };
    });

    let result: { note: import("../types/note.js").Note; proposal: Proposal; cascaded: string[] };
    try {
      result = runApprove();
    } catch (err) {
      if (err instanceof ApproveVersionMismatch) {
        const freshNote = requireNoteRow(proposal.note_id);
        markArchiveRecommendationNeedsRebaseAndThrow(proposal, freshNote, reason);
      }
      throw err;
    }

    return {
      kind: "proposal",
      note: result.note,
      proposal: result.proposal,
      cascadedNeedsRebase: result.cascaded,
      policyWarnings: [],
    };
  }

  function rejectNote(id: string, reason: string): RejectResult {
    const note = requireNoteRow(id);
    if (note.status !== "draft") {
      throw new CiteHankoError("invalid_input", `${id} is ${note.status}; only draft notes can be rejected`, {
        details: { status: note.status },
      });
    }
    const now = new Date().toISOString();
    const metadata = decisionMetadata(false);
    const runReject = db.transaction(() => {
      const beforeSnapshot = buildNoteSnapshot(db, note);
      const updated: NoteRow = { ...note, status: "rejected", rejection_reason: reason, updated_at: now };
      db.prepare("UPDATE notes SET status=@status, rejection_reason=@rejection_reason, updated_at=@updated_at WHERE id=@id").run(
        updated,
      );
      history.record({
        entityType: "note",
        entityId: id,
        eventType: "note_rejected",
        actor,
        role,
        scope: note.scope,
        reason,
        beforeSnapshot,
        afterSnapshot: buildNoteSnapshot(db, updated),
        metadata,
      });
      return rowToNote(updated);
    });
    const updatedNote = runReject();
    return { kind: "note", id, status: "rejected", rejectionReason: reason, note: updatedNote };
  }

  function rejectProposal(id: string, reason: string): RejectResult {
    const proposal = requireProposalRow(id);
    if (proposal.status !== "pending_review" && proposal.status !== "needs_rebase") {
      throw new CiteHankoError(
        "invalid_input",
        `${id} is ${proposal.status}; only pending_review or needs_rebase proposals can be rejected`,
        { details: { status: proposal.status } },
      );
    }
    const note = getNoteRow(db, proposal.note_id);
    const now = new Date().toISOString();
    const metadata = decisionMetadata(false);
    const runReject = db.transaction(() => {
      const updated: ProposalRow = { ...proposal, status: "rejected", rejection_reason: reason, reviewed_by: actor, reviewed_at: now };
      db.prepare(
        "UPDATE update_proposals SET status='rejected', rejection_reason=@rejection_reason, reviewed_by=@reviewed_by, reviewed_at=@reviewed_at WHERE id=@id",
      ).run({ id, rejection_reason: reason, reviewed_by: actor, reviewed_at: now });
      history.record({
        entityType: "proposal",
        entityId: id,
        eventType: "proposal_rejected",
        actor,
        role,
        scope: note?.scope ?? null,
        reason,
        beforeSnapshot: { proposal },
        afterSnapshot: { proposal: updated },
        metadata,
      });
      return rowToProposal(updated);
    });
    const updatedProposal = runReject();
    return { kind: "proposal", id, status: "rejected", rejectionReason: reason, proposal: updatedProposal };
  }
}
