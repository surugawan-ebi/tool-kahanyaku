import type { Command } from "commander";
import { createContext } from "../../core/context.js";
import { startMcpServer } from "../../mcp/server.js";
import { handleError } from "../context.js";

export function registerMcpCommand(program: Command): void {
  const cmd = program
    .command("mcp")
    .description("Start the MCP stdio server")
    .option("--actor <actor>", "actor identity for this MCP server process")
    .option("--data-dir <dir>", "data directory (default: ./.kahanyaku or $KAHANYAKU_HOME)")
    .action(async (opts: { actor?: string; dataDir?: string }) => {
      try {
        const ctx = createContext({ actor: opts.actor, dataDir: opts.dataDir });
        // startMcpServer owns ctx.db for the lifetime of the server; it is
        // intentionally not closed here.
        await startMcpServer(ctx);
      } catch (err) {
        handleError(cmd, err);
      }
    });
}
