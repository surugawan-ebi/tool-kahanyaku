import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../../core/context.js";
import { parseOrThrow } from "../../core/errors.js";
import { createReviewService } from "../../core/reviews.js";
import { PolicyWarningSchema } from "../schemas.js";
import { SourceInput } from "../../types/common.js";
import { okResult, errorResult, type ToolResult } from "../toolResponse.js";

export const GetReviewItemInput = z.object({
  id: z.string().min(1).describe("note_で始まるdraft/rejected noteのid、またはproposal_で始まるproposalのid。"),
});
export type GetReviewItemInput = z.infer<typeof GetReviewItemInput>;

export const GetReviewItemOutput = z.object({
  id: z.string(),
  kind: z.enum(["note", "proposal"]),
  status: z.string(),
  // kind:"note" only: the note's actual notes.status (status above is normalized, e.g.
  // "pending_review" for a draft note). See core/reviews.ts's normalizeNoteReviewStatus.
  note_status: z.string().optional(),
  // kind:"proposal" only: "update" or "archive_recommendation".
  proposal_type: z.enum(["update", "archive_recommendation"]).optional(),
  usable_as_context: z.literal(false),
  rejection_reason: z.string().nullable(),
  draft_reason: z.string().nullable().optional(),
  policy_warnings: z.array(PolicyWarningSchema),
  target_note_id: z.string().optional(),
  base_note_version: z.number().int().optional(),
  current_note_version: z.number().int().optional(),
  suggested_action: z.string().optional(),
  body: z.string(),
  diff: z.string().optional(),
  // proposal-only: not in spec.md's original get_review_item example, but a strict superset
  // (more information, same usable_as_context:false guard) is harmless and matches what
  // `kahanyaku show <proposal_id>` already surfaces on the CLI side.
  reason: z.string().optional(),
  source: z.array(SourceInput).optional(),
  proposed_by: z.string().optional(),
  changed_fields: z.array(z.string()).optional(),
});

export function getReviewItemTool(ctx: AppContext, rawInput: unknown): ToolResult {
  try {
    const input = parseOrThrow(GetReviewItemInput, rawInput ?? {});
    const reviews = createReviewService(ctx);
    const item = reviews.getReviewItem(input.id);

    return okResult({
      id: item.id,
      kind: item.kind,
      status: item.status,
      note_status: item.noteStatus,
      proposal_type: item.proposalType,
      usable_as_context: false,
      rejection_reason: item.rejectionReason,
      draft_reason: item.draftReason,
      policy_warnings: item.policyWarnings,
      target_note_id: item.targetNoteId,
      base_note_version: item.baseNoteVersion,
      current_note_version: item.currentNoteVersion,
      suggested_action: item.suggestedAction,
      body: item.body,
      diff: item.diff,
      reason: item.reason,
      source: item.source,
      proposed_by: item.proposedBy,
      changed_fields: item.changedFields,
    });
  } catch (err) {
    return errorResult(err);
  }
}

const DESCRIPTION = `[review plane] note_またはproposal_のIDから、全文とレビュー状態を返す。usable_as_contextは常にfalseで、正式根拠として使わないことを示す。
statusはレビュー系語彙に正規化されている: kind:"note"でnoteが実際はdraftの場合、statusは"pending_review"になり、元のnotes.status(例:"draft")はnote_status(kind:"note"のときのみ)で確認できる。
statusがneeds_rebaseのproposalには、base_note_version/current_note_version/target_note_id/suggested_actionが付き、AIが現行のverified noteを基準に(propose_note_updateで)再提案できるようにする。
proposalの場合はreason/source/proposed_by/changed_fieldsも含み、何がなぜ提案されたか把握できる。proposal_typeが"archive_recommendation"の場合、これは内容変更ではなくnoteのarchiveを人間に提案するもので、diffは空、reasonがarchiveを推奨する理由。
このツールはレビュー状況の把握のみに使い、回答の根拠にはget_note/search_notesで取得したverified noteを使うこと。`;

export function registerGetReviewItemTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_review_item",
    {
      title: "Get review item",
      description: DESCRIPTION,
      inputSchema: GetReviewItemInput.shape,
      outputSchema: GetReviewItemOutput.shape,
    },
    async (args) => getReviewItemTool(ctx, args),
  );
}
