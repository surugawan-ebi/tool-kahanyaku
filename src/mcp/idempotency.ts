import { createHash } from "node:crypto";
import type { AppContext } from "../core/context.js";
import { CiteHankoError } from "../core/errors.js";

/** An in_progress reservation older than this is treated as abandoned (e.g. the process
 *  that made it was killed mid-write) and can be taken over by a new attempt. */
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000;

interface IdempotencyRow {
  key: string;
  tool: string;
  actor: string;
  request_hash: string;
  status: "in_progress" | "completed";
  result_json: string | null;
  created_at: string;
}

/** Deterministic JSON serialization (object keys sorted) so hashing doesn't depend on key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** SHA-256 of a mutation's input, used to detect an idempotency_key being reused with different input. */
export function hashRequest(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/**
 * Wraps a mutating MCP tool (create_note_draft / update_draft / propose_note_update) so replaying
 * the same (tool, idempotency_key) with the same input is safe to retry: it returns the original
 * result instead of re-running the mutation. See detailed-design.md "MCP server 設計" and spec.md
 * "共通仕様".
 *
 * Reservations are scoped to (key, tool, actor): the same key from two different actors (e.g. two
 * MCP server processes started for different agents) never collides.
 *
 * Unlike wrapping the whole thing in one transaction, the reservation is committed in its own
 * short transaction *before* `mutate()` runs, so another process reading the db mid-mutation can
 * see the `in_progress` row (this is what makes the in_progress error actually observable across
 * processes, not just within a single connection). If `mutate()` throws, the reservation row is
 * deleted in a `finally` so the same key is retryable afterwards instead of being stuck forever.
 * An `in_progress` row older than STALE_IN_PROGRESS_MS is assumed abandoned (the writer died
 * mid-mutation) and is taken over by the new attempt rather than blocking it.
 */
export function withIdempotency<T>(
  ctx: AppContext,
  tool: string,
  idempotencyKey: string | null | undefined,
  input: unknown,
  mutate: () => T,
): T {
  if (!idempotencyKey) return mutate();

  const { db, actor } = ctx;
  const hash = hashRequest(input);

  const reserve = db.transaction((): "completed" | "reserved" => {
    const existing = db
      .prepare("SELECT * FROM idempotency_keys WHERE key = ? AND tool = ? AND actor = ?")
      .get(idempotencyKey, tool, actor) as IdempotencyRow | undefined;

    if (existing) {
      const ageMs = Date.now() - new Date(existing.created_at).getTime();
      const isAbandoned = existing.status === "in_progress" && ageMs > STALE_IN_PROGRESS_MS;

      if (!isAbandoned) {
        if (existing.request_hash !== hash) {
          throw new CiteHankoError(
            "invalid_input",
            `idempotency_key ${idempotencyKey} was already used with different input for ${tool}`,
            {
              details: { idempotency_key: idempotencyKey, tool },
              suggested_action: "use a new idempotency_key for different input, or resend the exact original request",
            },
          );
        }
        if (existing.status === "completed") {
          return "completed";
        }
        throw new CiteHankoError(
          "in_progress",
          `a request with idempotency_key ${idempotencyKey} is already in progress for ${tool}`,
          {
            details: { idempotency_key: idempotencyKey, tool },
            retryable: true,
            suggested_action: "wait and retry, or check list_review_items/get_note for the likely result",
          },
        );
      }

      // Abandoned reservation: take it over for this new attempt, regardless of its old hash.
      db.prepare(
        `UPDATE idempotency_keys SET request_hash = @request_hash, status = 'in_progress',
           result_json = NULL, created_at = @created_at
         WHERE key = @key AND tool = @tool AND actor = @actor`,
      ).run({ request_hash: hash, created_at: new Date().toISOString(), key: idempotencyKey, tool, actor });
      return "reserved";
    }

    db.prepare(
      `INSERT INTO idempotency_keys (key, tool, actor, request_hash, status, result_json, created_at)
       VALUES (@key, @tool, @actor, @request_hash, 'in_progress', NULL, @created_at)`,
    ).run({ key: idempotencyKey, tool, actor, request_hash: hash, created_at: new Date().toISOString() });
    return "reserved";
  });

  const outcome = reserve();
  if (outcome === "completed") {
    const row = db
      .prepare("SELECT result_json FROM idempotency_keys WHERE key = ? AND tool = ? AND actor = ?")
      .get(idempotencyKey, tool, actor) as { result_json: string };
    return JSON.parse(row.result_json) as T;
  }

  let result: T;
  try {
    result = mutate();
  } catch (err) {
    db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND tool = ? AND actor = ?").run(idempotencyKey, tool, actor);
    throw err;
  }

  db.prepare(
    "UPDATE idempotency_keys SET status = 'completed', result_json = @result_json WHERE key = @key AND tool = @tool AND actor = @actor",
  ).run({ result_json: JSON.stringify(result), key: idempotencyKey, tool, actor });

  return result;
}
