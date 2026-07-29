import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runCli, setupTmpProject, writeSeedFile, readNoteIds } from "./helpers.js";

describe("kahanyaku audit", () => {
  let project: { dir: string; cleanup: () => void };
  const originalActorEnv = process.env.KAHANYAKU_ACTOR;

  beforeEach(() => {
    project = setupTmpProject();
    process.env.KAHANYAKU_ACTOR = "agent:codex";
  });

  afterEach(() => {
    project.cleanup();
    if (originalActorEnv === undefined) delete process.env.KAHANYAKU_ACTOR;
    else process.env.KAHANYAKU_ACTOR = originalActorEnv;
  });

  async function seedApprovedNote(): Promise<string> {
    await runCli(["init"]);
    const seedDir = path.join(project.dir, "seed");
    writeSeedFile(
      seedDir,
      "note.md",
      `---\ntitle: "監査テストノート"\nsummary: "auditコマンドの動作確認用の十分な長さのある要約文です。"\nscope: support\nowner: cs-team\nsource:\n  - type: manual\n---\n# 概要\n本文\n`,
    );
    await runCli(["import", seedDir]);
    const [noteId] = readNoteIds(project.dir, { status: "draft" });
    await runCli(["approve", noteId, "--actor", "human:reviewer", "--reason", "looks good"]);
    return noteId;
  }

  it("defaults to jsonl on stdout with the documented fields", async () => {
    const noteId = await seedApprovedNote();

    const result = await runCli(["audit"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2); // note_created + note_verified at least

    const parsed = lines.map((l) => JSON.parse(l));
    const verifiedEvent = parsed.find((e) => e.entity_id === noteId && e.event_type === "note_verified");
    expect(verifiedEvent).toMatchObject({
      entity_type: "note",
      entity_id: noteId,
      event_type: "note_verified",
      actor: "human:reviewer",
      scope: "support",
    });
    expect(verifiedEvent.metadata.config_hash).toBeTruthy();
    // Snapshots are excluded by default.
    expect(verifiedEvent.before_snapshot).toBeUndefined();
    expect(verifiedEvent.after_snapshot).toBeUndefined();
  });

  it("--with-snapshots includes before/after snapshots in jsonl", async () => {
    await seedApprovedNote();

    const result = await runCli(["audit", "--with-snapshots"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    const verifiedEvent = parsed.find((e) => e.event_type === "note_verified");
    expect(verifiedEvent.before_snapshot).toBeDefined();
    expect(verifiedEvent.after_snapshot).toBeDefined();
  });

  it("--format csv produces a header row and flattened rows without snapshots", async () => {
    await seedApprovedNote();

    const result = await runCli(["audit", "--format", "csv"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("id,entity_type,entity_id,event_type,actor,role,scope,reason,metadata,created_at");
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + at least 2 events
    expect(result.stdout).not.toContain("before_snapshot");
  });

  it("--format csv --with-snapshots is rejected with invalid_input", async () => {
    await seedApprovedNote();

    const result = await runCli(["audit", "--format", "csv", "--with-snapshots"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid_input");
  });

  it("rejects an unrecognized --format value", async () => {
    await runCli(["init"]);
    const result = await runCli(["audit", "--format", "xml"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid_input");
  });

  it("--out writes to a file instead of stdout", async () => {
    await seedApprovedNote();
    const outFile = path.join(project.dir, "audit-out.jsonl");

    const result = await runCli(["audit", "--out", outFile]);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, "utf-8");
    expect(content.trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toContain("Wrote");
  });

  it("filters by --scope, --actor, and --entity", async () => {
    const noteId = await seedApprovedNote();

    const byScope = await runCli(["audit", "--scope", "support"]);
    expect(byScope.stdout.trim().split("\n").length).toBeGreaterThan(0);

    const byWrongScope = await runCli(["audit", "--scope", "does-not-exist"]);
    expect(byWrongScope.stdout.trim()).toBe("");

    const byActor = await runCli(["audit", "--actor", "human:reviewer"]);
    const actorLines = byActor.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(actorLines.every((e) => e.actor === "human:reviewer")).toBe(true);
    expect(actorLines.length).toBeGreaterThan(0);

    const byEntity = await runCli(["audit", "--entity", noteId]);
    const entityLines = byEntity.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(entityLines.every((e) => e.entity_id === noteId)).toBe(true);
    expect(entityLines.length).toBeGreaterThanOrEqual(2);
  });

  it("--from/--to filter by created_at range", async () => {
    await seedApprovedNote();
    const future = new Date(Date.now() + 60_000).toISOString();

    const noneInFuture = await runCli(["audit", "--from", future]);
    expect(noneInFuture.stdout.trim()).toBe("");

    const past = new Date(Date.now() - 60_000).toISOString();
    const allSince = await runCli(["audit", "--from", past]);
    expect(allSince.stdout.trim().split("\n").filter(Boolean).length).toBeGreaterThan(0);
  });
});
