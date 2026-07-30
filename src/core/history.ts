import type { AppContext } from "./context.js";
import { newId } from "./ids.js";
import type { HistoryEvent, RecordEventInput } from "../types/history.js";

interface HistoryRow {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor: string;
  role: string;
  scope: string | null;
  reason: string | null;
  before_snapshot_json: string | null;
  after_snapshot_json: string | null;
  metadata_json: string;
  created_at: string;
}

function rowToEvent(row: HistoryRow): HistoryEvent {
  return {
    id: row.id,
    entityType: row.entity_type as HistoryEvent["entityType"],
    entityId: row.entity_id,
    eventType: row.event_type as HistoryEvent["eventType"],
    actor: row.actor,
    role: row.role,
    scope: row.scope,
    reason: row.reason,
    beforeSnapshot: row.before_snapshot_json ? JSON.parse(row.before_snapshot_json) : null,
    afterSnapshot: row.after_snapshot_json ? JSON.parse(row.after_snapshot_json) : null,
    metadata: JSON.parse(row.metadata_json),
    createdAt: row.created_at,
  };
}

export interface HistoryEventQuery {
  /** Inclusive ISO 8601 lower bound on created_at. */
  from?: string;
  /** Inclusive ISO 8601 upper bound on created_at. */
  to?: string;
  scope?: string;
  actor?: string;
  entityId?: string;
}

export interface HistoryService {
  record(input: RecordEventInput): HistoryEvent;
  listByEntity(entityId: string): HistoryEvent[];
  /** Cross-entity query for `kahanyaku audit`: filters by any combination of
   *  from/to/scope/actor/entityId, oldest first (same tie-break as listByEntity). */
  queryEvents(query: HistoryEventQuery): HistoryEvent[];
}

export function createHistoryService(ctx: AppContext): HistoryService {
  const { db } = ctx;

  return {
    record(input: RecordEventInput): HistoryEvent {
      const row: HistoryRow = {
        id: newId("hist"),
        entity_type: input.entityType,
        entity_id: input.entityId,
        event_type: input.eventType,
        actor: input.actor,
        role: input.role,
        scope: input.scope ?? null,
        reason: input.reason ?? null,
        before_snapshot_json: input.beforeSnapshot ? JSON.stringify(input.beforeSnapshot) : null,
        after_snapshot_json: input.afterSnapshot ? JSON.stringify(input.afterSnapshot) : null,
        metadata_json: JSON.stringify(input.metadata ?? {}),
        created_at: new Date().toISOString(),
      };
      db.prepare(
        `INSERT INTO history_events
           (id, entity_type, entity_id, event_type, actor, role, scope, reason,
            before_snapshot_json, after_snapshot_json, metadata_json, created_at)
         VALUES (@id, @entity_type, @entity_id, @event_type, @actor, @role, @scope, @reason,
            @before_snapshot_json, @after_snapshot_json, @metadata_json, @created_at)`,
      ).run(row);
      return rowToEvent(row);
    },

    listByEntity(entityId: string): HistoryEvent[] {
      const rows = db
        // created_at has only millisecond resolution and ULIDs aren't ordered within
        // the same millisecond, so tie-break on rowid (SQLite's implicit insertion
        // order) to keep same-tick events in the order they were recorded.
        .prepare("SELECT * FROM history_events WHERE entity_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(entityId) as HistoryRow[];
      return rows.map(rowToEvent);
    },

    queryEvents(query: HistoryEventQuery): HistoryEvent[] {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (query.from) {
        clauses.push("created_at >= @from");
        params.from = query.from;
      }
      if (query.to) {
        clauses.push("created_at <= @to");
        params.to = query.to;
      }
      if (query.scope) {
        clauses.push("scope = @scope");
        params.scope = query.scope;
      }
      if (query.actor) {
        clauses.push("actor = @actor");
        params.actor = query.actor;
      }
      if (query.entityId) {
        clauses.push("entity_id = @entityId");
        params.entityId = query.entityId;
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM history_events ${where} ORDER BY created_at ASC, rowid ASC`)
        .all(params) as HistoryRow[];
      return rows.map(rowToEvent);
    },
  };
}
