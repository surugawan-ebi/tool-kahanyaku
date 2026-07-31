#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerMcpHttpCommand } from "./commands/mcpHttp.js";
import { registerListCommand } from "./commands/list.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerShowCommand } from "./commands/show.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerRejectCommand } from "./commands/reject.js";
import { registerArchiveCommand } from "./commands/archive.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerExportCommand } from "./commands/export.js";
import { registerImportCommand } from "./commands/import.js";
import { registerAuditCommand } from "./commands/audit.js";

/**
 * Builds a fresh Command tree. exitOverride() is enabled unconditionally here
 * (not left to callers) because Commander copies _exitCallback/_outputConfiguration
 * onto each subcommand at the moment `.command()` runs -- calling exitOverride()
 * after subcommands already exist would leave them still calling process.exit()
 * directly. Tests get a throwing CommanderError instead of a killed process;
 * the real CLI entry point below turns that back into a process exit code.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("kahanyaku")
    .description("AI proposes. Humans countersign. Human-governed knowledge review for AI agents.")
    .exitOverride();

  registerInitCommand(program);
  registerMcpCommand(program);
  registerMcpHttpCommand(program);
  registerListCommand(program);
  registerSearchCommand(program);
  registerShowCommand(program);
  registerApproveCommand(program);
  registerRejectCommand(program);
  registerArchiveCommand(program);
  registerHistoryCommand(program);
  registerExportCommand(program);
  registerImportCommand(program);
  registerAuditCommand(program);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  void main();
}
