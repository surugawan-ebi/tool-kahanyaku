import type { Command } from "commander";
import pc from "picocolors";
import { KahanyakuError } from "../core/errors.js";
import { Role, SourceType, type Role as RoleType, type SourceType as SourceTypeT } from "../types/common.js";

/** Validates a raw `--role` CLI value against the Role enum, or throws invalid_input. */
export function parseRoleOption(value: string | undefined): RoleType | undefined {
  if (value === undefined) return undefined;
  const parsed = Role.safeParse(value);
  if (!parsed.success) {
    throw new KahanyakuError("invalid_input", `invalid --role: ${value}`, {
      suggested_action: `use one of: ${Role.options.join(", ")}`,
    });
  }
  return parsed.data;
}

/** Validates a raw `--source` CLI value against the SourceType enum, or throws invalid_input. */
export function parseSourceTypeOption(value: string | undefined): SourceTypeT | undefined {
  if (value === undefined) return undefined;
  const parsed = SourceType.safeParse(value);
  if (!parsed.success) {
    throw new KahanyakuError("invalid_input", `invalid --source type: ${value}`, {
      suggested_action: `use one of: ${SourceType.options.join(", ")}`,
    });
  }
  return parsed.data;
}

/** Formats any thrown error for a human. KahanyakuError gets code/message/suggested_action; anything else falls back to its message. */
export function formatError(err: unknown): string {
  if (err instanceof KahanyakuError) {
    const lines = [`${pc.red("Error")} [${err.code}]: ${err.message}`];
    if (err.suggested_action) lines.push(`  suggested_action: ${err.suggested_action}`);
    if (err.details && Object.keys(err.details).length > 0) lines.push(`  details: ${JSON.stringify(err.details)}`);
    return lines.join("\n");
  }
  if (err instanceof Error) {
    return `${pc.red("Error")}: ${err.message}`;
  }
  return `${pc.red("Error")}: ${String(err)}`;
}

/**
 * Formats the error and hands it to Commander's error() so exit code / capture
 * behavior is consistent with the rest of the program (respects exitOverride()
 * in tests, calls process.exit(1) for the real CLI).
 */
export function handleError(command: Command, err: unknown): never {
  return command.error(formatError(err), { exitCode: 1 });
}
