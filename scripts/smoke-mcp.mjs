#!/usr/bin/env node
// Smoke test for the real MCP stdio server: spawns `node dist/cli/index.js mcp`
// as a child process (not an in-process test double) and talks to it over
// stdio via the official SDK Client, the same way a real MCP client would.
//
// Usage: npm run smoke   (builds nothing itself -- run `npm run build` first)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(repoRoot, "dist", "cli", "index.js");

if (!fs.existsSync(cliEntry)) {
  console.error(`✗ ${cliEntry} not found. Run "npm run build" first.`);
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kahanyaku-smoke-"));
let step = "startup";
let passed = 0;

// Config is loaded once at MCP server process startup (createContext() in mcp.ts), so it
// must exist before the server is spawned below -- writing it later would have no effect
// on the already-running process. Defines a context pack the get_context_pack step uses.
fs.writeFileSync(
  path.join(dataDir, "kahanyaku.config.yaml"),
  `context_packs:
  smoke_pack:
    description: "Smoke test pack"
    scopes: [smoke-test]
    tags: []
    note_ids: []
`,
);

function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed at step "${step}": ${message}`);
  }
}

async function main() {
  console.log(`[smoke-mcp] data dir: ${dataDir}`);
  console.log(`[smoke-mcp] spawning: node ${cliEntry} mcp --data-dir ${dataDir}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, "mcp", "--data-dir", dataDir],
    env: { ...process.env, KAHANYAKU_ACTOR: "agent:smoke-test" },
    stderr: "pipe",
  });

  // The CLI writes startup logs to stderr (stdout is reserved for MCP frames);
  // surface them so a hang is easy to diagnose.
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(`[server stderr] ${chunk}`);
  });

  const client = new Client({ name: "kahanyaku-smoke-test", version: "0.0.0" }, { capabilities: {} });

  try {
    step = "connect";
    await client.connect(transport);
    ok("connected to MCP server over stdio");

    step = "tools/list";
    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((t) => t.name).sort();
    const expected = [
      "create_note_draft",
      "get_context_pack",
      "get_note",
      "get_note_history",
      "get_registry_overview",
      "get_review_item",
      "list_review_items",
      "propose_note_update",
      "recommend_archive",
      "search_notes",
      "update_draft",
    ];
    assert(
      expected.every((name) => toolNames.includes(name)),
      `expected all 11 tools, got: ${toolNames.join(", ")}`,
    );
    assert(toolNames.length === 11, `expected exactly 11 tools, got ${toolNames.length}: ${toolNames.join(", ")}`);
    ok(`tools/list returned all 11 expected tools: ${toolNames.join(", ")}`);

    step = "get_registry_overview";
    const overview = await client.callTool({ name: "get_registry_overview", arguments: {} });
    assert(!overview.isError, `get_registry_overview returned isError: ${JSON.stringify(overview)}`);
    assert(overview.structuredContent?.schema_version === "1", "schema_version should be '1'");
    assert(Array.isArray(overview.structuredContent?.recommended_first_steps), "recommended_first_steps should be an array");
    assert(
      overview.structuredContent?.context_packs?.some((p) => p.name === "smoke_pack"),
      "expected the config-defined smoke_pack in context_packs",
    );
    ok(`get_registry_overview: schema_version=${overview.structuredContent.schema_version} server_version=${overview.structuredContent.server_version} scopes=${overview.structuredContent.scopes.length} context_packs=${overview.structuredContent.context_packs.length}`);

    step = "search_notes (0 results)";
    const emptySearch = await client.callTool({ name: "search_notes", arguments: { query: "存在しないキーワード" } });
    assert(!emptySearch.isError, "search_notes should not error on a fresh db");
    assert(emptySearch.structuredContent?.no_results === true, "expected no_results:true on a fresh db");
    assert(Array.isArray(emptySearch.structuredContent?.suggested_next_tools), "expected suggested_next_tools array");
    ok(`search_notes on empty db: no_results=true, guidance="${emptySearch.structuredContent.guidance.slice(0, 30)}..."`);

    step = "create_note_draft";
    const created = await client.callTool({
      name: "create_note_draft",
      arguments: {
        title: "スモークテスト用ノート",
        summary: "MCP stdio疎通確認のために作成した十分な長さのあるテストノートの要約文です。",
        body: "# 概要\nスモークテスト用の本文です。\n\n# 正本回答\nMCP経由で作成されました。",
        tags: ["smoke-test"],
        source: [{ type: "manual", title: "smoke-mcp.mjs" }],
        confidence: "medium",
        scope: "smoke-test",
      },
    });
    assert(!created.isError, `create_note_draft returned isError: ${JSON.stringify(created)}`);
    const noteId = created.structuredContent?.id;
    assert(typeof noteId === "string" && noteId.startsWith("note_"), `expected a note_ id, got ${noteId}`);
    assert(created.structuredContent?.status === "draft", "a freshly created note should be status:draft");
    ok(`create_note_draft: id=${noteId} status=${created.structuredContent.status} slug_adjusted=${created.structuredContent.slug_adjusted}`);

    step = "get_review_item";
    const reviewItem = await client.callTool({ name: "get_review_item", arguments: { id: noteId } });
    assert(!reviewItem.isError, `get_review_item returned isError: ${JSON.stringify(reviewItem)}`);
    assert(reviewItem.structuredContent?.usable_as_context === false, "usable_as_context must always be false");
    assert(reviewItem.structuredContent?.kind === "note", "kind should be 'note' for a note_ id");
    ok(`get_review_item: kind=${reviewItem.structuredContent.kind} usable_as_context=${reviewItem.structuredContent.usable_as_context}`);

    step = "get_note on a draft (should error not_verified)";
    const getDraftAsNote = await client.callTool({ name: "get_note", arguments: { id: noteId } });
    assert(getDraftAsNote.isError === true, "get_note on a draft id should be isError:true");
    // Error results intentionally carry no structuredContent (see toolResponse.ts's errorResult
    // for why: the SDK client validates structuredContent against the tool's outputSchema even
    // on isError:true, and an error payload's shape never matches a success outputSchema). The
    // JSON is still available via the text content block.
    assert(getDraftAsNote.structuredContent === undefined, "error results should not set structuredContent");
    const errorPayload = JSON.parse(getDraftAsNote.content[0].text);
    assert(errorPayload.code === "not_verified", `expected not_verified, got ${errorPayload.code}`);
    ok(`get_note on a draft correctly errors: code=${errorPayload.code}`);

    step = "get_note_history on the draft note (before approval)";
    const historyBeforeApprove = await client.callTool({ name: "get_note_history", arguments: { id: noteId } });
    assert(!historyBeforeApprove.isError, `get_note_history returned isError: ${JSON.stringify(historyBeforeApprove)}`);
    assert(
      historyBeforeApprove.structuredContent?.events?.some((e) => e.event_type === "note_created"),
      "expected a note_created event in get_note_history",
    );
    ok(`get_note_history: ${historyBeforeApprove.structuredContent.events.length} event(s), most recent=${historyBeforeApprove.structuredContent.events[0].event_type}`);

    // approve/reject are human-only CLI operations (not exposed as MCP tools -- AI proposes,
    // only the human CLI approves), so drive this step through the real CLI binary against
    // the same data dir the MCP server has open, mirroring how a human reviewer would
    // approve a draft an agent created via MCP. --data-dir is init/mcp only (see CLAUDE.md /
    // context.ts's resolveDataDir), so other commands are pointed at it via KAHANYAKU_HOME.
    const cliEnv = { ...process.env, KAHANYAKU_HOME: dataDir };
    step = "approve the draft note via the CLI (human review step)";
    execFileSync(
      process.execPath,
      [cliEntry, "approve", noteId, "--actor", "human:smoke-reviewer", "--reason", "smoke test approval"],
      { stdio: "pipe", env: cliEnv },
    );
    ok(`approved ${noteId} via CLI`);

    step = "search_notes now finds the verified note (and reports a score)";
    const foundSearch = await client.callTool({ name: "search_notes", arguments: { query: "スモークテスト" } });
    assert(!foundSearch.isError, `search_notes returned isError: ${JSON.stringify(foundSearch)}`);
    assert(foundSearch.structuredContent?.results?.some((r) => r.id === noteId), "expected the verified note in search results");
    const foundResult = foundSearch.structuredContent.results.find((r) => r.id === noteId);
    assert(
      typeof foundResult.score === "number" || foundResult.score === null,
      "score should be a number or null",
    );
    ok(`search_notes found the verified note: score=${foundResult.score}`);

    step = "get_context_pack returns the verified note via its scope";
    const pack = await client.callTool({ name: "get_context_pack", arguments: { name: "smoke_pack" } });
    assert(!pack.isError, `get_context_pack returned isError: ${JSON.stringify(pack)}`);
    assert(pack.structuredContent?.name === "smoke_pack", "expected name:smoke_pack echoed back");
    assert(pack.structuredContent?.notes?.some((n) => n.id === noteId), "expected the verified note in the pack");
    const packedNote = pack.structuredContent.notes.find((n) => n.id === noteId);
    assert(packedNote.body === undefined, "body should be omitted by default (include_body not set)");
    ok(`get_context_pack: ${pack.structuredContent.notes.length} note(s), found ${noteId}`);

    step = "get_context_pack with an unknown pack name errors not_found";
    const missingPack = await client.callTool({ name: "get_context_pack", arguments: { name: "does_not_exist" } });
    assert(missingPack.isError === true, "expected isError:true for an unknown pack name");
    const missingPackError = JSON.parse(missingPack.content[0].text);
    assert(missingPackError.code === "not_found", `expected not_found, got ${missingPackError.code}`);
    assert(missingPackError.suggested_action?.includes("smoke_pack"), "expected available pack names in suggested_action");
    ok(`get_context_pack on an unknown name correctly errors: code=${missingPackError.code}`);

    step = "recommend_archive on the now-verified note";
    const archiveRec = await client.callTool({
      name: "recommend_archive",
      arguments: { note_id: noteId, reason: "スモークテスト用ノートのため、確認後にarchiveしてよい" },
    });
    assert(!archiveRec.isError, `recommend_archive returned isError: ${JSON.stringify(archiveRec)}`);
    const archiveProposalId = archiveRec.structuredContent?.proposal_id;
    assert(typeof archiveProposalId === "string" && archiveProposalId.startsWith("proposal_"), `expected a proposal_ id, got ${archiveProposalId}`);
    assert(archiveRec.structuredContent?.proposal_type === "archive_recommendation", "expected proposal_type:archive_recommendation");
    assert(archiveRec.structuredContent?.status === "pending_review", "a freshly created recommendation should be pending_review");
    ok(`recommend_archive: id=${archiveProposalId} status=${archiveRec.structuredContent.status}`);

    step = "list_review_items surfaces the archive recommendation with its proposal_type";
    const reviewItems = await client.callTool({ name: "list_review_items", arguments: { kind: "proposal" } });
    assert(!reviewItems.isError, `list_review_items returned isError: ${JSON.stringify(reviewItems)}`);
    const listedRec = reviewItems.structuredContent?.items?.find((i) => i.id === archiveProposalId);
    assert(listedRec !== undefined, "expected the archive recommendation to appear in list_review_items");
    assert(listedRec.proposal_type === "archive_recommendation", "expected proposal_type:archive_recommendation in list_review_items");
    ok(`list_review_items: found ${archiveProposalId} with proposal_type=${listedRec.proposal_type}`);

    step = "get_review_item on the archive recommendation";
    const archiveDetail = await client.callTool({ name: "get_review_item", arguments: { id: archiveProposalId } });
    assert(!archiveDetail.isError, `get_review_item returned isError: ${JSON.stringify(archiveDetail)}`);
    assert(archiveDetail.structuredContent?.proposal_type === "archive_recommendation", "expected proposal_type:archive_recommendation in get_review_item");
    ok(`get_review_item: proposal_type=${archiveDetail.structuredContent.proposal_type} reason="${archiveDetail.structuredContent.reason}"`);

    step = "approve the archive recommendation via the CLI, then confirm the note is archived";
    execFileSync(
      process.execPath,
      [cliEntry, "approve", archiveProposalId, "--actor", "human:smoke-reviewer2", "--reason", "confirmed obsolete"],
      { stdio: "pipe", env: cliEnv },
    );
    const getArchivedNote = await client.callTool({ name: "get_note", arguments: { id: noteId } });
    assert(!getArchivedNote.isError, `get_note on the archived note returned isError: ${JSON.stringify(getArchivedNote)}`);
    assert(getArchivedNote.structuredContent?.status === "archived", `expected status:archived, got ${getArchivedNote.structuredContent?.status}`);
    ok(`approved the archive recommendation via CLI: ${noteId} is now status=archived`);

    step = "get_note_history on the archive proposal";
    const proposalHistory = await client.callTool({ name: "get_note_history", arguments: { id: archiveProposalId, limit: 5 } });
    assert(!proposalHistory.isError, `get_note_history returned isError: ${JSON.stringify(proposalHistory)}`);
    assert(
      proposalHistory.structuredContent?.events?.some((e) => e.event_type === "proposal_approved"),
      "expected a proposal_approved event in get_note_history for the archive proposal",
    );
    ok(`get_note_history on ${archiveProposalId}: ${proposalHistory.structuredContent.events.length} event(s)`);

    console.log(`\n[smoke-mcp] PASSED (${passed} checks)`);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\n[smoke-mcp] FAILED at step "${step}"`);
  console.error(err);
  process.exitCode = 1;
});
