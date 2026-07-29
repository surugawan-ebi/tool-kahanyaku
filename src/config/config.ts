import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ScopeConfig = z.object({
  description: z.string().default(""),
  owners: z.array(z.string()).default([]),
  reviewers: z.array(z.string()).default([]),
});
export type ScopeConfig = z.infer<typeof ScopeConfig>;

export const RequiredVerifyField = z.enum(["source", "confidence", "owner"]);
export type RequiredVerifyField = z.infer<typeof RequiredVerifyField>;

export const SearchEngineMode = z.enum(["auto", "like", "fts5"]);
export type SearchEngineMode = z.infer<typeof SearchEngineMode>;

/**
 * A named, curated slice of verified notes for AI clients to fetch in one call
 * (get_context_pack). Selector semantics (see core/contextPacks.ts): membership is
 * (note.scope is one of `scopes` OR'd together, AND note has every tag in `tags`)
 * UNION (note.id is explicitly pinned in `note_ids`). An empty `scopes` contributes no
 * notes via the scope/tag path (only explicit pins apply); an empty `tags` is vacuously
 * satisfied by every note (no tag filter). Archived notes are never distributed, even
 * if pinned.
 */
export const ContextPackConfig = z.object({
  description: z.string().default(""),
  scopes: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  note_ids: z.array(z.string()).default([]),
});
export type ContextPackConfig = z.infer<typeof ContextPackConfig>;

export const KahanyakuConfigSchema = z.object({
  default_search_status: z.literal("verified").default("verified"),
  strict_stale_filter: z.boolean().default(false),
  default_review_interval_days: z.number().int().positive().default(90),
  required_fields_for_verify: z.array(RequiredVerifyField).default(["source", "confidence", "owner"]),
  // "warn" (default): reviewer_separation is a policy_warning only, approval still succeeds.
  // "enforce": approve is a hard policy_violation error when authorActor === approving actor.
  // Unlike scope_reviewers, there is no maintainer bypass for this one -- see policy.ts.
  reviewer_separation: z.enum(["warn", "enforce"]).default("warn"),
  note_body_max_chars: z.number().int().positive().default(8000),
  scopes: z.record(z.string(), ScopeConfig).default({}),
  default_actor: z.string().optional(),
  // "auto": use FTS5(trigram) when this SQLite build supports it, else LIKE.
  // "like": always the LIKE engine. "fts5": require FTS5(trigram); errors at search-engine
  // construction time (not a silent LIKE fallback) if this environment doesn't support it.
  search_engine: SearchEngineMode.default("auto"),
  // "warn" (default): approving outside scopes.<scope>.reviewers is a policy_warning
  // (not_scope_reviewer) only. "enforce": a non-maintainer actor not listed in that scope's
  // reviewers[] (or a scope with no reviewers configured, or no scope at all) is rejected
  // with policy_violation; a maintainer can still approve (break-glass, recorded in history
  // metadata as scope_reviewer_bypass: true). See policy.ts's assertApprovalAuthorized.
  scope_reviewers: z.enum(["warn", "enforce"]).default("warn"),
  context_packs: z.record(z.string(), ContextPackConfig).default({}),
  // Hard cap on a single note's body length in get_context_pack's include_body:true
  // response; longer bodies are truncated with body_truncated:true. Distinct from
  // note_body_max_chars (an authoring-time policy_warning threshold, not a wire-size cap).
  max_body_chars: z.number().int().positive().default(8000),
});
export type KahanyakuConfig = z.infer<typeof KahanyakuConfigSchema>;

export const DEFAULT_CONFIG: KahanyakuConfig = KahanyakuConfigSchema.parse({});

export const CONFIG_FILE_NAME = "kahanyaku.config.yaml";

/**
 * Loads `<dataDir>/kahanyaku.config.yaml`. Missing file, or a file with only
 * some keys set, falls back to DEFAULT_CONFIG for the rest.
 */
export function loadConfig(dataDir: string): KahanyakuConfig {
  const configPath = path.join(dataDir, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) ?? {};
  return KahanyakuConfigSchema.parse(parsed);
}

/** Renders the default config as YAML text for `kahanyaku init` to write out. */
export function renderDefaultConfigYaml(): string {
  return `default_search_status: verified
strict_stale_filter: false
default_review_interval_days: 90
required_fields_for_verify: [source, confidence, owner]
# warn: reviewer_separation is a policy_warning only. enforce: hard-reject approving
# your own draft/proposal (no maintainer bypass for this one).
reviewer_separation: warn
note_body_max_chars: 8000
# auto: FTS5(trigram) when this SQLite build supports it, else LIKE. like: always LIKE.
# fts5: require FTS5(trigram); fails clearly at startup if unsupported instead of
# silently falling back.
search_engine: auto
# warn: approving outside scopes.<scope>.reviewers is a policy_warning only. enforce:
# rejected unless the approving actor is listed in that scope's reviewers (or is a
# maintainer, which bypasses the check and is recorded in history as a break-glass event).
scope_reviewers: warn
# Hard cap on a note's body length returned by get_context_pack when include_body:true.
max_body_chars: 8000
scopes:
  support:
    description: ""
    owners: []
    reviewers: []
# Named slices of verified notes for AI clients to fetch in one call via
# get_context_pack. Membership = (scope is one of "scopes" OR'd, AND has every tag in
# "tags") UNION note_ids (explicit pins). Archived notes are never distributed, even if
# pinned. Example (uncomment and adjust):
# context_packs:
#   support-core:
#     description: "Core support knowledge: refund policy, escalation, SOP"
#     scopes: [support]
#     tags: []
#     note_ids: []
`;
}

/** Deterministic JSON serialization (object keys sorted) so hashing doesn't depend on
 *  key order -- mirrors mcp/idempotency.ts's stableStringify, kept local here so
 *  config/ doesn't have to import from mcp/. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * SHA-256 of the effective config (key-order independent), recorded on approve/reject/
 * archive history events so an audit export can answer "which policy was this decided
 * under" without re-deriving it from the config file's git history.
 */
export function computeConfigHash(config: KahanyakuConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}
