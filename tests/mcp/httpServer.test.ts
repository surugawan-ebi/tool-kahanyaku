import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  resolveHttpMcpServerOptions,
  startHttpMcpServer,
  type RunningHttpMcpServer,
} from "../../src/mcp/httpServer.js";
import { makeTestContext } from "../helpers.js";

async function requestWithHost(url: string, host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const req = httpRequest(url, { headers: { Host: host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

describe("Streamable HTTP MCP server", () => {
  let running: RunningHttpMcpServer | undefined;
  let ctx: ReturnType<typeof makeTestContext> | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
    ctx?.db.close();
    ctx = undefined;
  });

  async function start() {
    ctx = makeTestContext({ actor: "agent:shared-http" });
    running = await startHttpMcpServer(ctx, { port: 0, log: () => undefined });
    return running;
  }

  it("serves all 11 agent-facing tools over stateless Streamable HTTP", async () => {
    const server = await start();
    const responseHeaders: Headers[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        responseHeaders.push(new Headers(response.headers));
        return response;
      },
    });
    const client = new Client({ name: "kahanyaku-http-test", version: "0.0.0" });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(11);
      expect(tools.map((tool) => tool.name)).toContain("get_registry_overview");
      expect(tools.map((tool) => tool.name)).not.toContain("approve_note");

      const overview = await client.callTool({ name: "get_registry_overview", arguments: {} });
      expect(overview.isError).toBeFalsy();
      expect((overview.structuredContent as { usage_policy: string }).usage_policy).toContain("verified");
      expect(responseHeaders.every((headers) => headers.get("mcp-session-id") === null)).toBe(true);
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("persists MCP mutations under the process-level actor", async () => {
    const server = await start();
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
    const client = new Client({ name: "kahanyaku-http-test", version: "0.0.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "create_note_draft",
        arguments: {
          title: "Remote MCP draft",
          summary: "A draft created through the shared Streamable HTTP endpoint for testing.",
          body: "# Overview\nCreated through remote MCP.\n\n# Canonical answer\nHuman review is still required.",
          tags: ["remote", "mcp"],
          source: [{ type: "url", url: "https://example.com/remote-mcp" }],
          confidence: "medium",
          scope: "support",
          idempotency_key: "http-server-test-draft",
        },
      });
      expect(result.isError).toBeFalsy();

      const row = ctx?.db
        .prepare("SELECT status, created_by FROM notes WHERE title = ?")
        .get("Remote MCP draft") as { status: string; created_by: string } | undefined;
      expect(row).toEqual({ status: "draft", created_by: "agent:shared-http" });
    } finally {
      await client.close();
    }
  });

  it("exposes a minimal health endpoint and rejects GET/DELETE on /mcp", async () => {
    const server = await start();

    const health = await fetch(`${server.mcpUrl.replace(/\/mcp$/, "")}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const getResponse = await fetch(server.mcpUrl);
    expect(getResponse.status).toBe(405);
    const deleteResponse = await fetch(server.mcpUrl, { method: "DELETE" });
    expect(deleteResponse.status).toBe(405);
  });

  it("returns non-leaking JSON-RPC errors for malformed JSON", async () => {
    const server = await start();
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Invalid JSON request body" },
      id: null,
    });
  });

  it("returns a non-leaking JSON-RPC error when the request body is too large", async () => {
    const server = await start();
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(110 * 1024) }),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Request body too large" },
      id: null,
    });
  });

  it("denies browser Origin headers by default and allows exact configured origins", async () => {
    const server = await start();
    const healthUrl = `${server.mcpUrl.replace(/\/mcp$/, "")}/healthz`;

    const denied = await fetch(healthUrl, { headers: { Origin: "https://untrusted.example" } });
    expect(denied.status).toBe(403);
    await server.close();

    running = await startHttpMcpServer(ctx!, {
      port: 0,
      allowedOrigins: ["https://console.example"],
      log: () => undefined,
    });
    const allowedUrl = `${running.mcpUrl.replace(/\/mcp$/, "")}/healthz`;
    const allowed = await fetch(allowedUrl, { headers: { Origin: "https://console.example" } });
    expect(allowed.status).toBe(200);
  });

  it("requires Host allowlisting for non-loopback binds", () => {
    expect(() => resolveHttpMcpServerOptions({ host: "0.0.0.0" })).toThrow(/requires at least one --allowed-host/);
    expect(
      resolveHttpMcpServerOptions({
        host: "0.0.0.0",
        allowedHosts: ["MCP.EXAMPLE.COM", "mcp.example.com"],
      }).allowedHosts,
    ).toEqual(["mcp.example.com"]);
    expect(() =>
      resolveHttpMcpServerOptions({ host: "0.0.0.0", allowedHosts: ["mcp.example.com:3000"] }),
    ).toThrow(/without scheme, port, or path/);
  });

  it("enforces the configured Host header allowlist", async () => {
    ctx = makeTestContext({ actor: "agent:shared-http" });
    running = await startHttpMcpServer(ctx, {
      port: 0,
      allowedHosts: ["mcp.example.com"],
      log: () => undefined,
    });
    const healthUrl = `${running.mcpUrl.replace(/\/mcp$/, "")}/healthz`;

    const denied = await fetch(healthUrl);
    expect(denied.status).toBe(403);

    expect(await requestWithHost(healthUrl, "mcp.example.com")).toBe(200);
  });
});
