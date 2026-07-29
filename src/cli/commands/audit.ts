import type { Command } from "commander";
import fs from "node:fs";
import { createContext, type AppContext } from "../../core/context.js";
import { createHistoryService } from "../../core/history.js";
import { KahanyakuError } from "../../core/errors.js";
import { handleError } from "../context.js";
import type { HistoryEvent } from "../../types/history.js";

interface AuditOptions {
  from?: string;
  to?: string;
  scope?: string;
  actor?: string;
  entity?: string;
  format?: string;
  out?: string;
  withSnapshots?: boolean;
}

const CSV_HEADERS = ["id", "entity_type", "entity_id", "event_type", "actor", "role", "scope", "reason", "metadata", "created_at"];

/** Quotes a CSV field only when needed (contains a comma, quote, or newline), doubling
 *  internal quotes -- the standard CSV escaping rule, no library required. */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvRow(e: HistoryEvent): string {
  return [e.id, e.entityType, e.entityId, e.eventType, e.actor, e.role, e.scope ?? "", e.reason ?? "", JSON.stringify(e.metadata), e.createdAt]
    .map(csvField)
    .join(",");
}

function toJsonlLine(e: HistoryEvent, withSnapshots: boolean): string {
  const line: Record<string, unknown> = {
    id: e.id,
    entity_type: e.entityType,
    entity_id: e.entityId,
    event_type: e.eventType,
    actor: e.actor,
    role: e.role,
    scope: e.scope,
    reason: e.reason,
    metadata: e.metadata,
    created_at: e.createdAt,
  };
  if (withSnapshots) {
    line.before_snapshot = e.beforeSnapshot;
    line.after_snapshot = e.afterSnapshot;
  }
  return JSON.stringify(line);
}

export function registerAuditCommand(program: Command): void {
  const cmd = program
    .command("audit")
    .description("Export history events (approve/reject/archive/etc.) for external audit or compliance review")
    .option("--from <iso>", "inclusive lower bound on created_at (ISO 8601)")
    .option("--to <iso>", "inclusive upper bound on created_at (ISO 8601)")
    .option("--scope <scope>", "filter by scope")
    .option("--actor <actor>", "filter by actor")
    .option("--entity <id>", "filter by entity id (note_... or proposal_...)")
    .option("--format <format>", "jsonl or csv (default jsonl)")
    .option("--out <file>", "write to a file instead of stdout")
    .option("--with-snapshots", "include before/after snapshots (jsonl only; invalid_input with --format csv)")
    .action(async (opts: AuditOptions) => {
      let ctx: AppContext | undefined;
      try {
        const format = opts.format ?? "jsonl";
        if (format !== "jsonl" && format !== "csv") {
          throw new KahanyakuError("invalid_input", `invalid --format: ${format}`, {
            suggested_action: "use --format jsonl or --format csv",
          });
        }
        if (format === "csv" && opts.withSnapshots) {
          throw new KahanyakuError("invalid_input", "--with-snapshots is only supported with --format jsonl", {
            suggested_action: "drop --with-snapshots, or use --format jsonl",
          });
        }

        ctx = createContext({});
        const history = createHistoryService(ctx);
        const events = history.queryEvents({
          from: opts.from,
          to: opts.to,
          scope: opts.scope,
          actor: opts.actor,
          entityId: opts.entity,
        });

        const lines =
          format === "csv"
            ? [CSV_HEADERS.join(","), ...events.map(toCsvRow)]
            : events.map((e) => toJsonlLine(e, Boolean(opts.withSnapshots)));
        const output = lines.join("\n");

        if (opts.out) {
          // Files conventionally end with a trailing newline; console.log (used for the
          // stdout path below) already appends one per call, so this only matters here.
          fs.writeFileSync(opts.out, lines.length > 0 ? `${output}\n` : "", "utf-8");
          console.log(`Wrote ${events.length} event(s) to ${opts.out}`);
        } else {
          // console.log (not process.stdout.write) so CLI tests, which spy on console.log
          // for output capture, see this like every other command's output.
          console.log(output);
        }
      } catch (err) {
        handleError(cmd, err);
      } finally {
        ctx?.db.close();
      }
    });
}
