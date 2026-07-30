import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { CommanderError } from "commander";
import { buildProgram } from "../../src/cli/index.js";
import { openDb } from "../../src/db/client.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one CLI invocation against a fresh Command tree (buildProgram()), the
 * same way a real `kahanyaku <args>` process would. Commander-level errors
 * (cmd.error(), required-option validation, etc.) are captured via
 * configureOutput(); normal application output goes through console.log, so
 * it's captured by spying on console.log instead (configureOutput only covers
 * Commander's own help/error machinery, not arbitrary action-handler output).
 */
export async function runCli(args: string[]): Promise<CliResult> {
  const program = buildProgram();
  let stderr = "";
  const stdoutLines: string[] = [];

  program.configureOutput({
    writeOut: (str) => {
      stdoutLines.push(str);
    },
    writeErr: (str) => {
      stderr += str;
    },
    outputError: (str, write) => write(str),
  });

  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdoutLines.push(parts.map(String).join(" "));
  });

  try {
    await program.parseAsync(args, { from: "user" });
    return { exitCode: 0, stdout: stdoutLines.join("\n"), stderr };
  } catch (err) {
    if (err instanceof CommanderError) {
      return { exitCode: err.exitCode, stdout: stdoutLines.join("\n"), stderr };
    }
    throw err;
  } finally {
    logSpy.mockRestore();
  }
}

/**
 * Creates a tmp project directory and chdirs into it, so the CLI's default
 * relative paths (./.kahanyaku, data/notes) resolve the same way they would
 * for a real user running `kahanyaku` from a project directory. Call
 * cleanup() in an afterEach to restore cwd and remove the tmp dir.
 */
export function setupTmpProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kahanyaku-cli-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  return {
    dir,
    cleanup: () => {
      process.chdir(originalCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function writeSeedFile(dir: string, name: string, contents: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

/** Reads note ids straight from the SQLite file for test setup/assertions (bypassing the CLI). */
export function readNoteIds(projectDir: string, opts: { status?: string; orderBy?: "created_at" | "updated_at" } = {}): string[] {
  const db = openDb(path.join(projectDir, ".kahanyaku"));
  try {
    const orderBy = opts.orderBy ?? "created_at";
    const rows = opts.status
      ? db.prepare(`SELECT id FROM notes WHERE status = ? ORDER BY ${orderBy} ASC`).all(opts.status)
      : db.prepare(`SELECT id FROM notes ORDER BY ${orderBy} ASC`).all();
    return (rows as { id: string }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}

export function readProposalIds(projectDir: string): string[] {
  const db = openDb(path.join(projectDir, ".kahanyaku"));
  try {
    const rows = db.prepare("SELECT id FROM update_proposals ORDER BY created_at ASC").all();
    return (rows as { id: string }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}
