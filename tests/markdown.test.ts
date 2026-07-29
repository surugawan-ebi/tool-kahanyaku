import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { exportAll, importPath } from "../src/core/markdown.js";
import { createNoteService } from "../src/core/notes.js";
import { createReviewService } from "../src/core/reviews.js";
import { getNoteRow } from "../src/core/noteRows.js";
import { makeTestContext, insertNoteFixture } from "./helpers.js";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kahanyaku-md-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeMd(dir: string, name: string, frontmatter: Record<string, unknown>, body: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, matter.stringify(body, frontmatter), "utf-8");
  return filePath;
}

describe("exportAll", () => {
  it("writes one <slug>--<id>.md file per non-rejected note", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_e1", slug: "refund-policy", status: "verified", title: "返金ポリシー" });
    insertNoteFixture(ctx, { id: "note_e2", slug: "draft-note", status: "draft", title: "下書き" });
    insertNoteFixture(ctx, { id: "note_e3", slug: "rejected-note", status: "rejected", title: "却下済み" });

    const outDir = tmpDir();
    const summary = exportAll(ctx, outDir);

    expect(summary.exported).toBe(2);
    const files = fs.readdirSync(outDir);
    expect(files).toContain("refund-policy--note_e1.md");
    expect(files).toContain("draft-note--note_e2.md");
    expect(files.some((f) => f.includes("note_e3"))).toBe(false);
  });

  it("includes spec.md's frontmatter fields", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(ctx, { id: "note_e4", slug: "with-frontmatter", status: "verified", title: "T", tags: ["a", "b"] });

    const outDir = tmpDir();
    exportAll(ctx, outDir);
    const raw = fs.readFileSync(path.join(outDir, "with-frontmatter--note_e4.md"), "utf-8");
    const parsed = matter(raw);
    expect(parsed.data.id).toBe("note_e4");
    expect(parsed.data.status).toBe("verified");
    expect(parsed.data.version).toBe(1);
    expect(parsed.data.tags).toEqual(["a", "b"]);
  });

  it("wipes stale .md files from a previous export", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const outDir = tmpDir();
    fs.writeFileSync(path.join(outDir, "stale--note_old.md"), "stale content");

    insertNoteFixture(ctx, { id: "note_e5", slug: "fresh", status: "verified" });
    exportAll(ctx, outDir);

    expect(fs.existsSync(path.join(outDir, "stale--note_old.md"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "fresh--note_e5.md"))).toBe(true);
  });
});

describe("importPath", () => {
  it("creates a new draft from a file with no id", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    const dir = tmpDir();
    writeMd(
      dir,
      "refund.md",
      { title: "返金ポリシー", summary: "返金の条件についての十分に長い要約文です。", tags: ["support"], scope: "support" },
      "# 概要\n返金は30日以内に受け付けます。",
    );

    const summary = importPath(ctx, dir);
    expect(summary.createdDrafts).toBe(1);
    expect(summary.createdIds).toHaveLength(1);
    const note = getNoteRow(ctx.db, summary.createdIds[0]);
    expect(note?.status).toBe("draft");
    expect(note?.title).toBe("返金ポリシー");
  });

  it("re-importing an exported note into an empty db reuses the original id (roundtrip)", () => {
    const sourceCtx = makeTestContext({ actor: "agent:codex" });
    insertNoteFixture(sourceCtx, {
      id: "note_roundtrip1",
      slug: "roundtrip-note",
      status: "verified",
      title: "ラウンドトリップノート",
      tags: ["support"],
    });
    const outDir = tmpDir();
    exportAll(sourceCtx, outDir);

    const freshCtx = makeTestContext({ actor: "human:reviewer" });
    const summary = importPath(freshCtx, outDir);

    expect(summary.createdIds).toContain("note_roundtrip1");
    const reimported = getNoteRow(freshCtx.db, "note_roundtrip1");
    expect(reimported).toBeDefined();
    expect(reimported?.title).toBe("ラウンドトリップノート");
  });

  it("updates an existing draft in place (version+1), not a proposal", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    const notes = createNoteService({ ...ctx, actor: "agent:codex" });
    const created = notes.createDraft({
      title: "旧タイトル",
      summary: "元の要約文です。二十文字以上の長さがあります。",
      body: "# 概要\n元の本文",
      tags: [],
      source: [],
      reason: "seed",
      confidence: "medium",
    });

    const dir = tmpDir();
    writeMd(dir, "updated.md", { id: created.note.id, title: "新タイトル", summary: created.note.summary }, "# 概要\n更新後の本文");

    const summary = importPath(ctx, dir);
    expect(summary.updatedDrafts).toBe(1);
    expect(summary.createdDrafts).toBe(0);
    const updated = getNoteRow(ctx.db, created.note.id);
    expect(updated?.title).toBe("新タイトル");
    expect(updated?.version).toBe(2);
    expect(updated?.status).toBe("draft");
  });

  it("does not wipe sources/tags when a partial re-import omits them (draft update)", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    const created = notes.createDraft({
      title: "元タイトル",
      summary: "元の要約文です。二十文字以上の長さがあります。",
      body: "# 概要\n元の本文",
      tags: ["support", "faq"],
      source: [{ type: "url", url: "https://example.com/a" }],
      confidence: "medium",
    });

    const dir = tmpDir();
    // Only title is repeated; tags/source/summary are omitted entirely.
    writeMd(dir, "partial.md", { id: created.note.id, title: "タイトルのみ変更" }, "# 概要\n元の本文");

    importPath(ctx, dir);
    const detail = createNoteService(ctx).getNoteForReview(created.note.id);
    expect(detail.title).toBe("タイトルのみ変更");
    expect(detail.summary).toBe("元の要約文です。二十文字以上の長さがあります。");
    expect(detail.tags).toEqual(["faq", "support"]);
    expect(detail.sources.map((s) => s.url)).toEqual(["https://example.com/a"]);
  });

  it("creates an update proposal when a verified note's content differs", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    insertNoteFixture(ctx, {
      id: "note_verified_import",
      slug: "verified-import",
      status: "verified",
      version: 1,
      title: "現行タイトル",
      body: "# 概要\n現行の本文",
    });

    const dir = tmpDir();
    writeMd(
      dir,
      "verified-import.md",
      { id: "note_verified_import", title: "現行タイトル" },
      "# 概要\n新しい本文に更新されました。",
    );

    const summary = importPath(ctx, dir);
    expect(summary.proposals).toBe(1);
    expect(summary.proposalIds).toHaveLength(1);

    const reviews = createReviewService(ctx);
    const item = reviews.getReviewItem(summary.proposalIds[0]);
    expect(item.targetNoteId).toBe("note_verified_import");
  });

  it("skips a verified note import when there is no actual change", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    insertNoteFixture(ctx, {
      id: "note_unchanged",
      slug: "unchanged",
      status: "verified",
      version: 1,
      title: "変わらないタイトル",
      body: "# 概要\n変わらない本文",
    });

    const dir = tmpDir();
    writeMd(dir, "unchanged.md", { id: "note_unchanged", title: "変わらないタイトル" }, "# 概要\n変わらない本文");

    const summary = importPath(ctx, dir);
    expect(summary.proposals).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("skips archived and rejected notes with a warning, without aborting the batch", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    insertNoteFixture(ctx, { id: "note_archived_import", slug: "archived-import", status: "archived" });
    insertNoteFixture(ctx, { id: "note_rejected_import", slug: "rejected-import", status: "rejected" });

    const dir = tmpDir();
    writeMd(dir, "archived.md", { id: "note_archived_import", title: "x" }, "# 概要\nbody");
    writeMd(dir, "rejected.md", { id: "note_rejected_import", title: "x" }, "# 概要\nbody");
    writeMd(dir, "new.md", { title: "新規ノート", summary: "十分な長さのある新規ノートの要約文です。" }, "# 概要\n新規本文");

    const summary = importPath(ctx, dir);
    expect(summary.skipped).toBe(2);
    expect(summary.createdDrafts).toBe(1);
    expect(summary.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("auto-suffixes the slug when a brand-new import collides with an existing slug", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    insertNoteFixture(ctx, { id: "note_existing_slug", slug: "shared-slug", status: "verified" });

    const dir = tmpDir();
    writeMd(dir, "new.md", { slug: "shared-slug", title: "新しいノート", summary: "衝突するslugを持つ新規ノートの要約文です。" }, "# 概要\n本文");

    const summary = importPath(ctx, dir);
    expect(summary.createdDrafts).toBe(1);
    const created = getNoteRow(ctx.db, summary.createdIds[0]);
    expect(created?.slug).toBe("shared-slug-2");
  });

  it("with --verified, verifies new drafts that satisfy required_fields_for_verify", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    const dir = tmpDir();
    writeMd(
      dir,
      "verified-seed.md",
      {
        title: "検証済みシード",
        summary: "十分な長さのある検証済みシードノートの要約文です。",
        owner: "cs-team",
        confidence: "medium",
        source: [{ type: "manual", title: "seed" }],
      },
      "# 概要\nシード本文",
    );

    const summary = importPath(ctx, dir, { verified: true });
    const created = getNoteRow(ctx.db, summary.createdIds[0]);
    expect(created?.status).toBe("verified");
    expect(created?.verified_at).not.toBeNull();
  });

  it("with --verified, falls back to draft (with a warning) when a required field is missing", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    const dir = tmpDir();
    writeMd(
      dir,
      "no-owner.md",
      { title: "オーナー無し", summary: "オーナーが設定されていないノートの要約文です。", source: [{ type: "manual" }] },
      "# 概要\n本文",
    );

    const summary = importPath(ctx, dir, { verified: true });
    const created = getNoteRow(ctx.db, summary.createdIds[0]);
    expect(created?.status).toBe("draft");
    expect(summary.warnings.some((w) => w.message.includes("could not verify"))).toBe(true);
  });

  it("with --verified, runs checkApprove and surfaces reviewer_separation (the importer is necessarily the note's own author)", () => {
    const ctx = makeTestContext({ actor: "human:reviewer" });
    const dir = tmpDir();
    writeMd(
      dir,
      "self-approved.md",
      {
        title: "自己承認ノート",
        summary: "importしたactor自身がcreated_byになる新規ノートの要約文です。",
        owner: "cs-team",
        confidence: "medium",
        source: [{ type: "manual", title: "seed" }],
      },
      "# 概要\n本文",
    );

    const summary = importPath(ctx, dir, { verified: true });
    const created = getNoteRow(ctx.db, summary.createdIds[0]);
    expect(created?.status).toBe("verified");
    expect(
      summary.warnings.some((w) => w.message.includes("policy warnings") && w.message.includes("reviewer_separation")),
    ).toBe(true);
  });

  it("with --verified and reviewer_separation:enforce, falls back to draft (does not abort the batch) since the importer is the author", () => {
    const ctx = makeTestContext({ actor: "human:reviewer", config: { reviewer_separation: "enforce" } });
    const dir = tmpDir();
    writeMd(
      dir,
      "enforce-self.md",
      {
        title: "enforceモードの自己承認ノート",
        summary: "reviewer_separation enforce下でimport --verifiedされる要約文です。",
        owner: "cs-team",
        confidence: "medium",
        source: [{ type: "manual", title: "seed" }],
      },
      "# 概要\n本文",
    );

    const summary = importPath(ctx, dir, { verified: true });
    const created = getNoteRow(ctx.db, summary.createdIds[0]);
    expect(created?.status).toBe("draft");
    expect(summary.warnings.some((w) => w.message.includes("could not verify"))).toBe(true);
  });

  it("includes tags and sources in the note_updated history snapshot for a draft re-import (not just the note row)", () => {
    const ctx = makeTestContext({ actor: "agent:codex" });
    const notes = createNoteService(ctx);
    const created = notes.createDraft({
      title: "元タイトル2",
      summary: "元の要約文です。二十文字以上の長さがあります。",
      body: "# 概要\n元の本文",
      tags: ["support"],
      source: [{ type: "url", url: "https://example.com/b" }],
      confidence: "medium",
    });

    const dir = tmpDir();
    writeMd(
      dir,
      "resnap.md",
      { id: created.note.id, title: "新タイトル2", tags: ["support", "faq"], source: [{ type: "manual" }] },
      "# 概要\n更新後の本文",
    );
    importPath(ctx, dir);

    const events = ctx.db
      .prepare(
        "SELECT before_snapshot_json, after_snapshot_json FROM history_events WHERE entity_id = ? AND event_type = 'note_updated'",
      )
      .get(created.note.id) as { before_snapshot_json: string; after_snapshot_json: string };
    const before = JSON.parse(events.before_snapshot_json);
    const after = JSON.parse(events.after_snapshot_json);
    expect(before.tags).toEqual(["support"]);
    expect(before.sources).toHaveLength(1);
    expect(before.sources[0].url).toBe("https://example.com/b");
    expect(after.tags.sort()).toEqual(["faq", "support"]);
    expect(after.sources).toHaveLength(1);
    expect(after.sources[0].type).toBe("manual");
  });
});
