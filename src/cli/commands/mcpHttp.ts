import { InvalidArgumentError, type Command } from "commander";
import { createContext } from "../../core/context.js";
import { startHttpMcpServer } from "../../mcp/httpServer.js";
import { handleError } from "../context.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(`port must be an integer between 1 and 65535: ${value}`);
  }
  return port;
}

interface McpHttpCommandOptions {
  actor?: string;
  dataDir?: string;
  host: string;
  port: number;
  allowedHost: string[];
  allowedOrigin: string[];
}

export function registerMcpHttpCommand(program: Command): void {
  const cmd = program
    .command("mcp-http")
    .description("Start the opt-in stateless Streamable HTTP MCP server")
    .option("--actor <actor>", "fixed actor identity recorded for every client of this server")
    .option("--data-dir <dir>", "data directory (default: ./.kahanyaku or $KAHANYAKU_HOME)")
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("--port <port>", "listen port", parsePort, 3000)
    .option(
      "--allowed-host <hostname>",
      "allowed Host header hostname; repeatable and required for non-loopback binds",
      collect,
      [],
    )
    .option(
      "--allowed-origin <origin>",
      "allowed browser Origin; repeatable, exact http(s) origins only",
      collect,
      [],
    )
    .action(async (opts: McpHttpCommandOptions) => {
      let ctx: ReturnType<typeof createContext> | undefined;
      try {
        ctx = createContext({ actor: opts.actor, dataDir: opts.dataDir });
        const running = await startHttpMcpServer(ctx, {
          host: opts.host,
          port: opts.port,
          allowedHosts: opts.allowedHost,
          allowedOrigins: opts.allowedOrigin,
        });

        let shuttingDown = false;
        const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
          if (shuttingDown) return;
          shuttingDown = true;
          process.stderr.write(`[kahanyaku] received ${signal}; shutting down HTTP MCP server\n`);
          try {
            await running.close();
          } finally {
            ctx?.db.close();
          }
        };

        const requestShutdown = (signal: NodeJS.Signals): void => {
          void shutdown(signal).catch((error: unknown) => {
            process.stderr.write(`[kahanyaku] HTTP MCP shutdown failed: ${String(error)}\n`);
            ctx?.db.close();
            process.exitCode = 1;
          });
        };

        process.once("SIGINT", () => requestShutdown("SIGINT"));
        process.once("SIGTERM", () => requestShutdown("SIGTERM"));
      } catch (error) {
        ctx?.db.close();
        handleError(cmd, error);
      }
    });
}
