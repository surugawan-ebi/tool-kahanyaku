import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { KahanyakuError } from "../core/errors.js";

export type ToolResult = CallToolResult;

/**
 * Wraps a JSON-serializable tool result as both `structuredContent` (the source of truth,
 * validated against the tool's outputSchema by the SDK) and a `content: [{type:"text"}]`
 * fallback for MCP clients that only read text content. See detailed-design.md "MCP server 設計".
 */
export function okResult(structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * Uniform error envelope for every tool: KahanyakuError -> {code, message, details, retryable,
 * suggested_action} JSON, returned as isError:true (per spec.md "共通仕様"). Anything that isn't
 * a KahanyakuError (a bug, not a modeled domain error) is still wrapped in the same shape so a
 * tool call never throws past the SDK boundary; `internal_error` is not one of core/errors.ts's
 * ERROR_CODES on purpose, so it's easy to tell "expected domain error" apart from "unexpected bug"
 * in client logs.
 *
 * Deliberately omits `structuredContent`: the error payload's shape (code/message/details/...)
 * doesn't match the tool's outputSchema (which documents the *success* shape only), and
 * @modelcontextprotocol/sdk's Client.callTool validates structuredContent against outputSchema
 * whenever it's present -- including on isError:true results, despite that method's own comment
 * saying it shouldn't (verified against the installed SDK: dist/esm/client/index.js's callTool
 * checks `if (result.structuredContent)` with no `!isError` guard on that branch). Setting it
 * would make every error from every tool an uncatchable client-side McpError instead of a normal
 * isError:true tool result. The JSON `content` text block still carries the full payload.
 */
export function errorResult(err: unknown): ToolResult {
  const payload =
    err instanceof KahanyakuError
      ? err.toJSON()
      : {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}
