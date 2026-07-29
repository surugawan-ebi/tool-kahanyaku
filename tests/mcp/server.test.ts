import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { makeTestContext, insertNoteFixture } from "../helpers.js";

const EXPECTED_TOOL_NAMES = [
  "get_registry_overview",
  "search_notes",
  "get_note",
  "get_context_pack",
  "create_note_draft",
  "update_draft",
  "propose_note_update",
  "recommend_archive",
  "list_review_items",
  "get_review_item",
  "get_note_history",
];

/** Connects a Client to a buildMcpServer(ctx) instance over an in-memory transport pair
 *  (no stdio process spawned), so we can exercise the full SDK request/response path,
 *  including its own inputSchema/outputSchema validation, in a unit test. */
async function connectedClient(ctx: ReturnType<typeof makeTestContext>) {
  const server = buildMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

describe("buildMcpServer", () => {
  it("registers exactly the 11 agent-facing tools from spec.md", async () => {
    const ctx = makeTestContext();
    const { client } = await connectedClient(ctx);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.description, `${tool.name} should have a description`).toBeTruthy();
    }
  });

  it("get_registry_overview's description tells the client to call it first", async () => {
    const ctx = makeTestContext();
    const { client } = await connectedClient(ctx);
    const { tools } = await client.listTools();
    const overview = tools.find((t) => t.name === "get_registry_overview");
    expect(overview?.description).toContain("最初");
  });

  it("round-trips a real tool call through the SDK's own schema validation", async () => {
    const ctx = makeTestContext({
      config: { scopes: { support: { description: "", owners: [], reviewers: [] } } },
    });
    insertNoteFixture(ctx, { id: "note_1", status: "verified", scope: "support" });
    const { client } = await connectedClient(ctx);

    const result = await client.callTool({ name: "get_registry_overview", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { scopes: Array<{ scope: string }> }).scopes.map((s) => s.scope)).toContain(
      "support",
    );
  });

  it("surfaces a KahanyakuError JSON payload with isError:true for a not_found id", async () => {
    const ctx = makeTestContext();
    const { client } = await connectedClient(ctx);
    // Fetch tools/list first (as any well-behaved client does, e.g. Claude Desktop) so the
    // SDK caches get_note's outputSchema and its client-side output validator actually runs
    // on the next callTool -- this is what previously caught error results being rejected
    // because their shape doesn't match the *success* outputSchema (see toolResponse.ts).
    await client.listTools();

    const result = await client.callTool({ name: "get_note", arguments: { id: "note_does_not_exist" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { code: string };
    expect(payload.code).toBe("not_found");
  });

  it("passes the SDK's own outputSchema validation for a note-kind get_review_item result (sparse optional fields)", async () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_g1", status: "draft", createdBy: "agent:codex" });
    const { client } = await connectedClient(ctx);

    // A draft note leaves proposal-only fields (target_note_id/base_note_version/...) unset;
    // this exercises the real McpServer.validateToolOutput path against that sparse shape.
    const result = await client.callTool({ name: "get_review_item", arguments: { id: "note_g1" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ id: "note_g1", kind: "note", usable_as_context: false });
  });
});
