import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runCli, setupTmpProject, writeSeedFile, readNoteIds } from "./helpers.js";

describe("citehanko CLI error handling", () => {
  let project: { dir: string; cleanup: () => void };

  beforeEach(() => {
    project = setupTmpProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it("reject without --reason fails with a non-zero exit code and a usage message", async () => {
    await runCli(["init"]);
    const result = await runCli(["reject", "note_doesnotexist"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("reason");
  });

  it("archive without --reason fails", async () => {
    await runCli(["init"]);
    const result = await runCli(["archive", "note_doesnotexist"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("reason");
  });

  it("approve on an unknown id surfaces the not_found CiteHankoError", async () => {
    await runCli(["init"]);
    const result = await runCli(["approve", "note_doesnotexist", "--reason", "x"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not_found");
  });

  it("show with an unrecognized id prefix surfaces not_found", async () => {
    await runCli(["init"]);
    const result = await runCli(["show", "garbage-id"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not_found");
  });

  it("archive refuses to archive a note that is still a draft", async () => {
    await runCli(["init"]);
    writeSeedFile(
      path.join(project.dir, "seed"),
      "note.md",
      `---\ntitle: "テストノート"\nsummary: "十分な長さのあるテストノートの要約文です。"\nowner: cs-team\nsource:\n  - type: manual\n---\n# 概要\n本文\n`,
    );
    await runCli(["import", path.join(project.dir, "seed")]);
    const [noteId] = readNoteIds(project.dir, { status: "draft" });

    const result = await runCli(["archive", noteId, "--reason", "too early"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid_input");
  });

  it("approve rejects an invalid --role value", async () => {
    await runCli(["init"]);
    const result = await runCli(["approve", "note_doesnotexist", "--role", "not-a-real-role"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid_input");
  });

  it("import --source rejects an invalid source type", async () => {
    await runCli(["init"]);
    const result = await runCli(["import", path.join(project.dir, "does-not-exist.md"), "--source", "not-a-real-type"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid_input");
  });

  it("search with no notes yet returns the no_results guidance instead of erroring", async () => {
    await runCli(["init"]);
    const result = await runCli(["search", "存在しないキーワード"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No results");
  });

  it("history on an id with no events prints a friendly message rather than an error", async () => {
    await runCli(["init"]);
    const result = await runCli(["history", "note_doesnotexist"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No history found");
  });

  it("commands work even without an explicit init (lazy db/config creation)", async () => {
    const result = await runCli(["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No notes found");
  });

  it("init --data-dir places the database at the given directory instead of ./.citehanko", async () => {
    const result = await runCli(["init", "--data-dir", "custom-data"]);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(project.dir, "custom-data", "citehanko.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(project.dir, ".citehanko"))).toBe(false);
  });
});
