import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppContext } from "../core/context.js";
import { createSearchEngine } from "../core/search.js";
import { registerGetRegistryOverviewTool } from "./tools/getRegistryOverview.js";
import { registerSearchNotesTool } from "./tools/searchNotes.js";
import { registerGetNoteTool } from "./tools/getNote.js";
import { registerGetContextPackTool } from "./tools/getContextPack.js";
import { registerCreateNoteDraftTool } from "./tools/createNoteDraft.js";
import { registerUpdateDraftTool } from "./tools/updateDraft.js";
import { registerProposeNoteUpdateTool } from "./tools/proposeNoteUpdate.js";
import { registerRecommendArchiveTool } from "./tools/recommendArchive.js";
import { registerListReviewItemsTool } from "./tools/listReviewItems.js";
import { registerGetReviewItemTool } from "./tools/getReviewItem.js";
import { registerGetNoteHistoryTool } from "./tools/getNoteHistory.js";

// Mirrors core/registry.ts's readServerVersion (not exported from there), so the MCP
// Implementation.version reported to clients matches get_registry_overview's server_version.
function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/mcp/server.js -> ../../package.json resolves to the repo root either way.
    const pkgPath = path.join(here, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Assembles the McpServer and registers all 11 agent-facing tools (spec.md "Agent-facing MCP
 * Tools"), without connecting a transport. Kept separate from startMcpServer so tests can call
 * tool handlers directly without spawning a stdio process.
 */
export function buildMcpServer(ctx: AppContext): McpServer {
  // Fails fast at server construction time (not lazily on the first search_notes call) when
  // config.search_engine is explicitly "fts5" but this environment doesn't support the FTS5
  // trigram tokenizer -- see createSearchEngine's doc comment in core/search.ts. The engine
  // itself is discarded; searchNotesTool constructs its own per call.
  createSearchEngine(ctx);

  const server = new McpServer({ name: "kahanyaku", version: readPackageVersion() });

  registerGetRegistryOverviewTool(server, ctx);
  registerSearchNotesTool(server, ctx);
  registerGetNoteTool(server, ctx);
  registerGetContextPackTool(server, ctx);
  registerCreateNoteDraftTool(server, ctx);
  registerUpdateDraftTool(server, ctx);
  registerProposeNoteUpdateTool(server, ctx);
  registerRecommendArchiveTool(server, ctx);
  registerListReviewItemsTool(server, ctx);
  registerGetReviewItemTool(server, ctx);
  registerGetNoteHistoryTool(server, ctx);

  return server;
}

/**
 * Entry point used by `kahanyaku mcp`: builds the server and serves it over stdio.
 * stdout is reserved for MCP protocol frames; all logging goes to stderr.
 */
export async function startMcpServer(ctx: AppContext): Promise<void> {
  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();
  process.stderr.write(
    `[kahanyaku] starting MCP server (actor=${ctx.actor}, role=${ctx.role}, dataDir=${ctx.dataDir})\n`,
  );
  await server.connect(transport);
  process.stderr.write("[kahanyaku] MCP server ready (stdio)\n");
}
