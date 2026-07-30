import type { ZodType } from "zod";

export const ERROR_CODES = [
  "not_found",
  "not_verified",
  "invalid_input",
  "empty_change",
  "version_conflict",
  "archived_target",
  "rejected_target",
  "not_draft_owner",
  "slug_conflict",
  "io_error",
  // A request with this idempotency_key is still mid-write (see mcp/idempotency.ts).
  // Distinct from version_conflict (an optimistic-lock mismatch on note content).
  "in_progress",
  // An "enforce"-mode policy blocked this operation (scope_reviewers / reviewer_separation).
  // Distinct from the "warn"-mode case, which is a policy_warning on an otherwise-successful
  // response, not this error.
  "policy_violation",
] as const;

export type KahanyakuErrorCode = (typeof ERROR_CODES)[number];

export interface KahanyakuErrorOptions {
  details?: Record<string, unknown>;
  retryable?: boolean;
  suggested_action?: string;
  cause?: unknown;
}

/** Uniform error shape surfaced verbatim by MCP tools and formatted for CLI output. */
export class KahanyakuError extends Error {
  readonly code: KahanyakuErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly suggested_action?: string;

  constructor(code: KahanyakuErrorCode, message: string, options: KahanyakuErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "KahanyakuError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.suggested_action = options.suggested_action;
  }

  toJSON(): { code: KahanyakuErrorCode; message: string; details?: Record<string, unknown>; retryable: boolean; suggested_action?: string } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      suggested_action: this.suggested_action,
    };
  }
}

/**
 * Parses input against a zod schema, converting ZodError into the uniform KahanyakuError
 * shape. Constrained as ZodType<Output, any, any> (not ZodSchema<T>, which pins Input = Output)
 * so schemas with `.default()`/`.nullish()` fields infer the post-parse Output type correctly.
 */
export function parseOrThrow<Output>(schema: ZodType<Output, any, any>, input: unknown): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new KahanyakuError("invalid_input", message, { details: { issues: result.error.issues } });
  }
  return result.data;
}
