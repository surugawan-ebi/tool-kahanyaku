import { expect } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Unwraps a successful ToolResult's structuredContent, failing the test if the tool errored. */
export function structured<T = Record<string, unknown>>(result: CallToolResult): T {
  expect(result.isError, `expected a non-error result, got: ${JSON.stringify(result.content)}`).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  // structuredContent must round-trip through the same JSON the text fallback carries.
  expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
  return result.structuredContent as T;
}

/**
 * Unwraps an error ToolResult's KahanyakuError-shaped JSON payload, failing the test if it
 * didn't error. Error results carry the payload only in `content[0].text` (JSON), not
 * `structuredContent` -- see toolResponse.ts's errorResult() for why.
 */
export function errorPayload(result: CallToolResult): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  suggested_action?: string;
} {
  expect(result.isError, "expected an error result").toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as ReturnType<typeof errorPayload>;
}
