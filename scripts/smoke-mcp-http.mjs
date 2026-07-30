#!/usr/bin/env node
// Smoke test for the real opt-in Streamable HTTP process. Run `npm run build` first.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(repoRoot, "dist", "cli", "index.js");

if (!fs.existsSync(cliEntry)) {
  console.error(`✗ ${cliEntry} not found. Run "npm run build" first.`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealth(url, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP MCP process exited before readiness (code=${child.exitCode})\n${stderr()}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // Startup races are expected for a short time.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}\n${stderr()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP MCP process did not stop")), 5_000)),
  ]);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kahanyaku-http-smoke-"));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderrBuffer = "";
  const child = spawn(
    process.execPath,
    [cliEntry, "mcp-http", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
    {
      env: { ...process.env, KAHANYAKU_ACTOR: "agent:http-smoke" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  let client;
  try {
    await waitForHealth(`${baseUrl}/healthz`, child, () => stderrBuffer);
    console.log(`  ✓ health check passed at ${baseUrl}/healthz`);

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    client = new Client({ name: "kahanyaku-http-smoke", version: "0.0.0" });
    await client.connect(transport);
    assert(transport.sessionId === undefined, "stateless HTTP transport must not issue a session id");

    const { tools } = await client.listTools();
    assert(tools.length === 11, `expected 11 tools, got ${tools.length}`);
    assert(!tools.some((tool) => tool.name === "approve_note"), "approve must not be exposed over MCP");
    console.log("  ✓ connected and received exactly 11 agent-facing tools");

    const created = await client.callTool({
      name: "create_note_draft",
      arguments: {
        title: "HTTP smoke draft",
        summary: "A real-process Streamable HTTP smoke test draft with sufficient summary length.",
        body: "# Overview\nRemote MCP smoke test.\n\n# Canonical answer\nHuman approval remains required.",
        tags: ["smoke", "http"],
        source: [{ type: "manual", title: "smoke-mcp-http.mjs" }],
        confidence: "medium",
        scope: "smoke-test",
        idempotency_key: "http-smoke-draft",
      },
    });
    assert(!created.isError, `create_note_draft failed: ${JSON.stringify(created)}`);
    assert(created.structuredContent?.status === "draft", "remote mutation must remain a draft");
    console.log(`  ✓ created draft ${created.structuredContent.id} as agent:http-smoke`);
    console.log("\n[smoke-mcp-http] PASSED");
  } finally {
    await client?.close().catch(() => undefined);
    let stopError;
    await stopChild(child).catch((error) => {
      child.kill("SIGKILL");
      stopError = error;
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (stopError) throw stopError;
  }
}

main().catch((error) => {
  console.error("\n[smoke-mcp-http] FAILED");
  console.error(error);
  process.exitCode = 1;
});
