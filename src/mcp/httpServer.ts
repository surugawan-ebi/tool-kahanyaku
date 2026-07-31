import type { Server as HttpServer } from "node:http";
import type { ErrorRequestHandler } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppContext } from "../core/context.js";
import { buildMcpServer } from "./server.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface HttpMcpServerOptions {
  host?: string;
  port?: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  log?: (message: string) => void;
}

export interface ResolvedHttpMcpServerOptions {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  log: (message: string) => void;
}

export interface RunningHttpMcpServer {
  server: HttpServer;
  host: string;
  port: number;
  mcpUrl: string;
  close: () => Promise<void>;
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function jsonRpcError(status: number, message: string, code = -32000): { status: number; body: object } {
  return {
    status,
    body: {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    },
  };
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeAllowedHost(hostname: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostname}`);
  } catch {
    throw new Error(`allowed host must be a hostname without scheme, port, or path: ${hostname}`);
  }
  if (
    hostname.includes("://") ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.length === 0
  ) {
    throw new Error(`allowed host must be a hostname without scheme, port, or path: ${hostname}`);
  }
  return parsed.hostname;
}

function normalizeAllowedOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`allowed origin must be an absolute http(s) origin: ${origin}`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin === "null") {
    throw new Error(`allowed origin must use http or https: ${origin}`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`allowed origin must not include credentials, a path, query, or fragment: ${origin}`);
  }
  return parsed.origin;
}

export function resolveHttpMcpServerOptions(options: HttpMcpServerOptions = {}): ResolvedHttpMcpServerOptions {
  const host = options.host?.trim() || "127.0.0.1";
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`port must be an integer between 0 and 65535: ${String(port)}`);
  }

  const allowedHosts = [...new Set(normalizeList(options.allowedHosts).map(normalizeAllowedHost))];
  if (!LOOPBACK_HOSTS.has(host) && allowedHosts.length === 0) {
    throw new Error(
      `non-loopback host ${host} requires at least one --allowed-host for Host header validation`,
    );
  }

  const allowedOrigins = normalizeList(options.allowedOrigins).map(normalizeAllowedOrigin);
  return {
    host,
    port,
    allowedHosts,
    allowedOrigins,
    log: options.log ?? defaultLog,
  };
}

function formatListenHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Starts a stateless, JSON-response Streamable HTTP MCP server.
 *
 * Authentication, TLS, rate limiting, and user-to-actor mapping intentionally live outside this
 * process. Every request is recorded as the process-level AppContext actor. The server defaults to
 * loopback and requires an explicit Host allowlist for every non-loopback bind.
 */
export async function startHttpMcpServer(
  ctx: AppContext,
  inputOptions: HttpMcpServerOptions = {},
): Promise<RunningHttpMcpServer> {
  const options = resolveHttpMcpServerOptions(inputOptions);
  const app = createMcpExpressApp({
    host: options.host,
    allowedHosts: options.allowedHosts.length > 0 ? options.allowedHosts : undefined,
  });
  app.disable("x-powered-by");

  // Native MCP clients normally omit Origin. Browser-originated requests are denied unless the
  // operator explicitly allowlists the exact origin; permissive CORS is not an authentication
  // mechanism and is intentionally not enabled here.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      const error = jsonRpcError(403, `Origin not allowed: ${origin}`);
      res.status(error.status).json(error.body);
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", async (req, res) => {
    let mcpServer: ReturnType<typeof buildMcpServer> | undefined;

    try {
      mcpServer = buildMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      options.log(`[kahanyaku] HTTP MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        const rpcError = jsonRpcError(500, "Internal server error");
        res.status(rpcError.status).json(rpcError.body);
      }
    } finally {
      await mcpServer?.close().catch((error: unknown) => {
        options.log(`[kahanyaku] failed to close request MCP server: ${String(error)}`);
      });
    }
  });

  const methodNotAllowed = (_req: unknown, res: { status: (code: number) => { json: (body: object) => void } }) => {
    const error = jsonRpcError(405, "Method not allowed. Use POST for the stateless MCP endpoint.");
    res.status(error.status).json(error.body);
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // createMcpExpressApp installs express.json() before our routes. Convert its malformed JSON and
  // body-size errors to non-leaking JSON-RPC responses instead of Express's default HTML error page.
  const expressErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const errorType = (error as { type?: unknown }).type;
    const isTooLarge = errorType === "entity.too.large";
    const isParseFailure = errorType === "entity.parse.failed";
    const status = isTooLarge ? 413 : isParseFailure ? 400 : 500;
    if (!isTooLarge && !isParseFailure) {
      options.log(`[kahanyaku] unexpected HTTP middleware error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rpcError = jsonRpcError(
      status,
      isTooLarge ? "Request body too large" : isParseFailure ? "Invalid JSON request body" : "Internal server error",
      isParseFailure ? -32700 : -32000,
    );
    res.status(rpcError.status).json(rpcError.body);
  };
  app.use(expressErrorHandler);

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const candidate = app.listen(options.port, options.host, () => {
      candidate.off("error", reject);
      resolve(candidate);
    });
    candidate.once("error", reject);
  });

  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  const baseUrl = `http://${formatListenHost(options.host)}:${boundPort}`;
  options.log(
    `[kahanyaku] Streamable HTTP MCP ready at ${baseUrl}/mcp (actor=${ctx.actor}, role=${ctx.role}, dataDir=${ctx.dataDir})`,
  );
  options.log(
    "[kahanyaku] WARNING: authentication, TLS, rate limiting, and per-user actor mapping are not built in; use a trusted reverse proxy or private network.",
  );

  let closed = false;
  return {
    server: httpServer,
    host: options.host,
    port: boundPort,
    mcpUrl: `${baseUrl}/mcp`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
