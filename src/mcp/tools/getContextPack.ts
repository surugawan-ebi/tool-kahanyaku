import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../../core/context.js";
import { parseOrThrow } from "../../core/errors.js";
import { createContextPackService } from "../../core/contextPacks.js";
import { Confidence } from "../../types/common.js";
import { CitationSchema } from "../schemas.js";
import { okResult, errorResult, type ToolResult } from "../toolResponse.js";

export const GetContextPackInput = z.object({
  name: z.string().min(1).describe("kahanyaku.config.yamlのcontext_packsに定義されたpack名。"),
  include_body: z.boolean().optional().describe("trueの場合、各noteの本文を含める(デフォルトはメタデータのみ)。"),
  limit: z.number().int().positive().max(100).optional().describe("省略時はinclude_body:falseで50件、trueで20件。"),
  cursor: z.string().nullish().describe("前回のnext_cursorを渡すとその続きから返す。"),
});
export type GetContextPackInput = z.infer<typeof GetContextPackInput>;

const ContextPackNoteOutput = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  scope: z.string().nullable(),
  tags: z.array(z.string()),
  confidence: Confidence,
  updated_at: z.string(),
  review_due_at: z.string().nullable(),
  stale: z.boolean(),
  citation: CitationSchema,
  body: z.string().optional(),
  body_truncated: z.boolean().optional(),
});

const ContextPackExclusionOutput = z.object({
  id: z.string(),
  reason: z.enum(["archived", "not_verified", "stale_filtered", "not_found"]),
});

export const GetContextPackOutput = z.object({
  name: z.string(),
  description: z.string(),
  notes: z.array(ContextPackNoteOutput),
  excluded: z.array(ContextPackExclusionOutput),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
  warnings: z.array(z.string()),
});

export function getContextPackTool(ctx: AppContext, rawInput: unknown): ToolResult {
  try {
    const input = parseOrThrow(GetContextPackInput, rawInput ?? {});
    const packs = createContextPackService(ctx);
    const result = packs.getPack(input.name, {
      includeBody: input.include_body,
      limit: input.limit,
      cursor: input.cursor ?? null,
    });

    return okResult({
      name: result.name,
      description: result.description,
      notes: result.notes.map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary,
        scope: n.scope,
        tags: n.tags,
        confidence: n.confidence,
        updated_at: n.updatedAt,
        review_due_at: n.reviewDueAt,
        stale: n.stale,
        citation: n.citation,
        body: n.body,
        body_truncated: n.bodyTruncated,
      })),
      excluded: result.excluded,
      truncated: result.truncated,
      next_cursor: result.nextCursor,
      warnings: result.warnings,
    });
  } catch (err) {
    return errorResult(err);
  }
}

const DESCRIPTION = `[verified plane] kahanyaku.config.yamlのcontext_packsで定義された、verified noteの厳選済みセットを一括取得する。get_registry_overviewのcontext_packs[]で利用可能なpack名を確認できる。
デフォルトはメタデータのみ(本文なし)。include_body:trueで本文も返すが、1件あたりmax_body_chars設定を超える本文は切り詰められbody_truncated:trueが付く。limitのデフォルトはinclude_body:falseで50件、trueで20件。結果がlimit件に達した場合はtruncated:trueとnext_cursorが付き、次回呼び出しのcursorに渡すと続きが取れる。
excluded[]には、pack定義の条件に該当したがこの呼び出しでは配布されなかったnoteとその理由が入る: archived(archiveされたnoteは、note_idsで明示pinされていても絶対に配らない) / not_verified(pinされたnoteがdraft/rejectedだった) / stale_filtered(strict_stale_filter:trueでstale noteが除外された) / not_found(pinされたnote_idが存在しない)。
strict_stale_filter:falseの場合、staleなnoteは含まれ、citationのstale:trueで示される。pack内にstale noteが1件以上あればwarningsに件数付きの注意文が入る。
存在しないpack名を指定するとnot_foundエラーになり、suggested_actionに利用可能なpack名が入る。回答の根拠として引用する際は各noteのcitationを使うこと。`;

export function registerGetContextPackTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_context_pack",
    {
      title: "Get context pack",
      description: DESCRIPTION,
      inputSchema: GetContextPackInput.shape,
      outputSchema: GetContextPackOutput.shape,
    },
    async (args) => getContextPackTool(ctx, args),
  );
}
