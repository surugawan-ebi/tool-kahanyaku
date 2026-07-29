import { describe, it, expect } from "vitest";
import { createNoteDraftTool, CreateNoteDraftInput } from "../../src/mcp/tools/createNoteDraft.js";
import { updateDraftTool } from "../../src/mcp/tools/updateDraft.js";
import { withIdempotency, hashRequest } from "../../src/mcp/idempotency.js";
import { CiteHankoError } from "../../src/core/errors.js";
import { makeTestContext, insertNoteFixture } from "../helpers.js";
import { structured, errorPayload } from "./toolTestHelpers.js";

function draftInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "アイデンポテンシーテスト用ノート",
    summary: "同一リクエストの再実行が安全であることを確認するためのテストノートです。",
    body: "# 概要\n本文\n\n# 正本回答\n本文",
    tags: ["test"],
    source: [{ type: "manual" }],
    confidence: "medium",
    idempotency_key: "key-1",
    ...overrides,
  };
}

describe("idempotency (mutating MCP tools)", () => {
  it("replaying the same idempotency_key with identical input returns the same result and causes no new side effect", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });

    const first = structured<{ id: string; final_slug: string }>(createNoteDraftTool(ctx, draftInput()));
    const second = structured<{ id: string; final_slug: string }>(createNoteDraftTool(ctx, draftInput()));

    expect(second).toEqual(first);
    const noteCount = ctx.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    expect(noteCount.c).toBe(1);
    const historyCount = ctx.db.prepare("SELECT COUNT(*) AS c FROM history_events").get() as { c: number };
    expect(historyCount.c).toBe(1);
  });

  it("errors invalid_input when the same key is reused with different input, and creates nothing new", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    createNoteDraftTool(ctx, draftInput());

    const err = errorPayload(createNoteDraftTool(ctx, draftInput({ title: "別のタイトルに変更しました" })));
    expect(err.code).toBe("invalid_input");
    expect(err.details).toMatchObject({ idempotency_key: "key-1", tool: "create_note_draft" });

    const noteCount = ctx.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    expect(noteCount.c).toBe(1);
  });

  it("errors retryable:true when a request with the same key is already in_progress", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const rawInput = draftInput({ idempotency_key: "key-in-progress" });
    // Simulate a prior request that inserted its bookkeeping row but never finished
    // (e.g. the process was killed mid-write) by inserting the row directly.
    const { idempotency_key, ...coreInput } = CreateNoteDraftInput.parse(rawInput);
    ctx.db
      .prepare(
        `INSERT INTO idempotency_keys (key, tool, actor, request_hash, status, result_json, created_at)
         VALUES (@key, @tool, @actor, @request_hash, 'in_progress', NULL, @created_at)`,
      )
      .run({
        key: idempotency_key,
        tool: "create_note_draft",
        actor: ctx.actor,
        request_hash: hashRequest(coreInput),
        created_at: new Date().toISOString(),
      });

    const err = errorPayload(createNoteDraftTool(ctx, rawInput));
    expect(err.code).toBe("in_progress");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("already in progress");

    const noteCount = ctx.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    expect(noteCount.c).toBe(0);
  });

  it("also protects update_draft: replaying the key does not bump the note's version twice", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_u1", status: "draft", createdBy: "agent:codex", version: 1 });

    const args = { id: "note_u1", title: "更新後タイトル", idempotency_key: "u-1" };
    const first = structured<{ id: string; status: string }>(updateDraftTool(ctx, args));
    const second = structured<{ id: string; status: string }>(updateDraftTool(ctx, args));
    expect(second).toEqual(first);

    const row = ctx.db.prepare("SELECT version FROM notes WHERE id = ?").get("note_u1") as { version: number };
    expect(row.version).toBe(2);
  });

  it("scopes reservations by actor: the same key from two different actors never collides", () => {
    const ctxA = makeTestContext({ actor: "agent:a" });
    const ctxB = { ...ctxA, actor: "agent:b" };

    const resultA = structured<{ id: string; final_slug: string }>(
      createNoteDraftTool(ctxA, draftInput({ idempotency_key: "shared-key", title: "Aのノート" })),
    );
    // Same key, different actor, *different* input -- must not throw invalid_input, since
    // reservations are keyed on (key, tool, actor), not just (key, tool).
    const resultB = structured<{ id: string; final_slug: string }>(
      createNoteDraftTool(ctxB, draftInput({ idempotency_key: "shared-key", title: "Bのノート" })),
    );

    expect(resultA.id).not.toBe(resultB.id);
    const noteCount = ctxA.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    expect(noteCount.c).toBe(2);
    const reservationCount = ctxA.db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE key = 'shared-key'").get() as {
      c: number;
    };
    expect(reservationCount.c).toBe(2);
  });

  it("deletes the reservation when mutate() throws, so the same key is retryable afterwards", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });

    expect(() =>
      withIdempotency(ctx, "test_tool", "retry-key", { a: 1 }, () => {
        throw new CiteHankoError("invalid_input", "deliberate failure for the test");
      }),
    ).toThrow(CiteHankoError);

    const afterFailure = ctx.db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE key = 'retry-key'").get() as {
      c: number;
    };
    expect(afterFailure.c).toBe(0);

    // Retrying with the same key now succeeds instead of being stuck as "in_progress" forever.
    const result = withIdempotency(ctx, "test_tool", "retry-key", { a: 1 }, () => "ok");
    expect(result).toBe("ok");
  });

  it("takes over an in_progress reservation older than 10 minutes instead of erroring", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const staleCreatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    ctx.db
      .prepare(
        `INSERT INTO idempotency_keys (key, tool, actor, request_hash, status, result_json, created_at)
         VALUES ('stale-key', 'test_tool', @actor, 'some-old-hash', 'in_progress', NULL, @created_at)`,
      )
      .run({ actor: ctx.actor, created_at: staleCreatedAt });

    const result = withIdempotency(ctx, "test_tool", "stale-key", { a: 1 }, () => "recovered");
    expect(result).toBe("recovered");

    const row = ctx.db.prepare("SELECT status, result_json FROM idempotency_keys WHERE key = 'stale-key'").get() as {
      status: string;
      result_json: string;
    };
    expect(row.status).toBe("completed");
    expect(JSON.parse(row.result_json)).toBe("recovered");
  });
});
