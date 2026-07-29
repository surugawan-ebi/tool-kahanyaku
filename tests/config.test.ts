import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG, renderDefaultConfigYaml } from "../src/config/config.js";

describe("loadConfig", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citehanko-"));
    tmpDirs.push(dir);
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it("merges a partial config file over the defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citehanko-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "citehanko.config.yaml"), "strict_stale_filter: true\nnote_body_max_chars: 100\n");
    const config = loadConfig(dir);
    expect(config.strict_stale_filter).toBe(true);
    expect(config.note_body_max_chars).toBe(100);
    expect(config.default_review_interval_days).toBe(90);
  });

  it("renderDefaultConfigYaml produces a file loadConfig can parse with the same scalar defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citehanko-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "citehanko.config.yaml"), renderDefaultConfigYaml());
    const config = loadConfig(dir);
    // renderDefaultConfigYaml seeds an example "support" scope (per detailed-design's
    // sample config), so scopes differs from the zero-config DEFAULT_CONFIG on purpose.
    expect(config).toMatchObject({
      default_search_status: DEFAULT_CONFIG.default_search_status,
      strict_stale_filter: DEFAULT_CONFIG.strict_stale_filter,
      default_review_interval_days: DEFAULT_CONFIG.default_review_interval_days,
      required_fields_for_verify: DEFAULT_CONFIG.required_fields_for_verify,
      reviewer_separation: DEFAULT_CONFIG.reviewer_separation,
      note_body_max_chars: DEFAULT_CONFIG.note_body_max_chars,
    });
    expect(config.scopes.support).toEqual({ description: "", owners: [], reviewers: [] });
  });
});
