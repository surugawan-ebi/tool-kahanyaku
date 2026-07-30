import path from "node:path";
import os from "node:os";
import { openDb, type KahanyakuDb } from "../db/client.js";
import { loadConfig, type KahanyakuConfig } from "../config/config.js";
import { Role, type Role as RoleType } from "../types/common.js";

export interface AppContext {
  db: KahanyakuDb;
  config: KahanyakuConfig;
  dataDir: string;
  actor: string;
  role: RoleType;
}

export interface CreateContextOptions {
  dataDir?: string;
  actor?: string;
  role?: RoleType;
  /** Role to fall back to when nothing else specifies one (approve/reject/archive default to "reviewer"). */
  defaultRole?: RoleType;
}

/** --data-dir > env KAHANYAKU_HOME > ./.kahanyaku */
export function resolveDataDir(explicit?: string): string {
  return path.resolve(explicit ?? process.env.KAHANYAKU_HOME ?? "./.kahanyaku");
}

/** --actor > env KAHANYAKU_ACTOR > config.default_actor > OS user */
export function resolveActor(explicit: string | undefined, config: KahanyakuConfig): string {
  return explicit ?? process.env.KAHANYAKU_ACTOR ?? config.default_actor ?? os.userInfo().username;
}

/** --role > env KAHANYAKU_ROLE > defaultRole ("contributor" unless caller overrides) */
export function resolveRole(explicit: RoleType | undefined, defaultRole: RoleType = "contributor"): RoleType {
  if (explicit) return explicit;
  const envRole = process.env.KAHANYAKU_ROLE;
  if (envRole) {
    const parsed = Role.safeParse(envRole);
    if (parsed.success) return parsed.data;
  }
  return defaultRole;
}

/** Builds the shared AppContext used by both CLI and MCP entry points. */
export function createContext(options: CreateContextOptions = {}): AppContext {
  const dataDir = resolveDataDir(options.dataDir);
  const config = loadConfig(dataDir);
  const db = openDb(dataDir);
  const actor = resolveActor(options.actor, config);
  const role = resolveRole(options.role, options.defaultRole ?? "contributor");
  return { db, config, dataDir, actor, role };
}
