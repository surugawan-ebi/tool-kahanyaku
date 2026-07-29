import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../../core/context.js";
import { CiteHankoError, parseOrThrow } from "../../core/errors.js";
import { createHistoryService } from "../../core/history.js";
import { getNoteRow } from "../../core/noteRows.js";
import { okResult, errorResult, type ToolResult } from "../toolResponse.js";

export const GetNoteHistoryInput = z.object({
  id: z.string().min(1).describe("note_で始まるnoteのid、またはproposal_で始まるproposalのid。"),
  limit: z.number().int().positive().max(200).nullish().describe("省略時は20件。直近のイベントから新しい順に返す。"),
});
export type GetNoteHistoryInput = z.infer<typeof GetNoteHistoryInput>;

const DEFAULT_LIMIT = 20;

const HistoryEventOutput = z.object({
  event_type: z.string(),
  actor: z.string(),
  role: z.string(),
  scope: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

export const GetNoteHistoryOutput = z.object({
  id: z.string(),
  events: z.array(HistoryEventOutput),
});

/** get_note_history only reports "does this id belong to a known entity kind" (note_/
 *  proposal_ prefix + row exists), matching the not_found behavior of get_note/get_review_item,
 *  rather than silently returning an empty events[] for a typo'd or never-existed id. */
function requireEntityExists(ctx: AppContext, id: string): void {
  if (id.startsWith("note_")) {
    if (getNoteRow(ctx.db, id)) return;
  } else if (id.startsWith("proposal_")) {
    const row = ctx.db.prepare("SELECT 1 FROM update_proposals WHERE id = ?").get(id);
    if (row) return;
  }
  throw new CiteHankoError("not_found", `${id} was not found`, { details: { id } });
}

export function getNoteHistoryTool(ctx: AppContext, rawInput: unknown): ToolResult {
  try {
    const input = parseOrThrow(GetNoteHistoryInput, rawInput ?? {});
    requireEntityExists(ctx, input.id);

    const history = createHistoryService(ctx);
    const events = history.listByEntity(input.id); // ascending (oldest first)
    const limit = input.limit ?? DEFAULT_LIMIT;
    // Most-recent-first, capped at limit: this tool is for a quick "what happened
    // recently" audit/context check, not the full chronological log.
    const recent = [...events].reverse().slice(0, limit);

    return okResult({
      id: input.id,
      events: recent.map((e) => ({
        event_type: e.eventType,
        actor: e.actor,
        role: e.role,
        scope: e.scope,
        reason: e.reason,
        created_at: e.createdAt,
      })),
    });
  } catch (err) {
    return errorResult(err);
  }
}

const DESCRIPTION = `note_またはproposal_のIDについて、監査・文脈把握用の変更履歴を返す。直近のイベントからlimit件(デフォルト20)を新しい順に返す。
each eventにはevent_type/actor/role/scope/reason/created_atのみを含み、before/afterのスナップショットは含まない(サイズが大きいため)。差分やスナップショットの詳細が必要な場合はCLIの\`citehanko history <id>\`を使うこと。
これは「誰が・いつ・なぜ」を把握するための監査ツールであり、noteの現在の正式な内容を得たい場合はget_noteを使うこと(このツールの出力自体を回答の根拠として引用しないこと)。`;

export function registerGetNoteHistoryTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_note_history",
    {
      title: "Get note or proposal history",
      description: DESCRIPTION,
      inputSchema: GetNoteHistoryInput.shape,
      outputSchema: GetNoteHistoryOutput.shape,
    },
    async (args) => getNoteHistoryTool(ctx, args),
  );
}
