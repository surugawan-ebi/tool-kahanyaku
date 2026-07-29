import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runCli, setupTmpProject, writeSeedFile, readNoteIds, readProposalIds } from "./helpers.js";
import { createContext } from "../../src/core/context.js";
import { createReviewService } from "../../src/core/reviews.js";

const seedMarkdown = `---
title: "返金ポリシー"
summary: "返金は購入から30日以内であれば全額対応します。詳細は下記を参照してください。"
tags:
  - support
  - refund
scope: support
owner: cs-team
confidence: medium
source:
  - type: manual
    title: "seed doc"
---
# 概要

返金ポリシーの本文です。

# 正本回答

30日以内であれば返金可能です。
`;

describe("citehanko CLI end-to-end flow", () => {
  let project: { dir: string; cleanup: () => void };
  const originalActorEnv = process.env.CITEHANKO_ACTOR;

  beforeEach(() => {
    project = setupTmpProject();
    process.env.CITEHANKO_ACTOR = "agent:codex";
  });

  afterEach(() => {
    project.cleanup();
    if (originalActorEnv === undefined) delete process.env.CITEHANKO_ACTOR;
    else process.env.CITEHANKO_ACTOR = originalActorEnv;
  });

  it("runs init -> import -> list --pending -> approve -> search -> show -> export -> history", async () => {
    // init
    const initResult = await runCli(["init"]);
    expect(initResult.exitCode).toBe(0);
    expect(fs.existsSync(path.join(project.dir, ".citehanko", "citehanko.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(project.dir, ".citehanko", "citehanko.config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(project.dir, "data", "notes"))).toBe(true);

    // init again: safe no-op, still exit 0
    const secondInit = await runCli(["init"]);
    expect(secondInit.exitCode).toBe(0);
    expect(secondInit.stdout).toContain("Already initialized");

    // import
    const seedDir = path.join(project.dir, "seed");
    writeSeedFile(seedDir, "refund.md", seedMarkdown);
    const importResult = await runCli(["import", seedDir]);
    expect(importResult.exitCode).toBe(0);
    expect(importResult.stdout).toContain("新規 draft: 1");

    const draftIds = readNoteIds(project.dir, { status: "draft" });
    expect(draftIds).toHaveLength(1);
    const noteId = draftIds[0];

    // list --pending shows the new draft
    const pendingResult = await runCli(["list", "--pending"]);
    expect(pendingResult.exitCode).toBe(0);
    expect(pendingResult.stdout).toContain(noteId);
    expect(pendingResult.stdout).toContain("support");

    // approve (as a different actor, to avoid the reviewer_separation warning muddying assertions)
    const approveResult = await runCli(["approve", noteId, "--actor", "human:reviewer", "--reason", "looks correct"]);
    expect(approveResult.exitCode).toBe(0);
    expect(approveResult.stdout).toContain("Approved");
    expect(approveResult.stdout).toContain(noteId);

    const verifiedIds = readNoteIds(project.dir, { status: "verified" });
    expect(verifiedIds).toEqual([noteId]);

    // search finds the now-verified note
    const searchResult = await runCli(["search", "返金"]);
    expect(searchResult.exitCode).toBe(0);
    expect(searchResult.stdout).toContain(noteId);
    expect(searchResult.stdout).toContain("citation:");

    // show renders full detail including status
    const showResult = await runCli(["show", noteId]);
    expect(showResult.exitCode).toBe(0);
    expect(showResult.stdout).toContain("status: verified");
    expect(showResult.stdout).toContain("返金ポリシー");

    // export writes the markdown file
    const exportResult = await runCli(["export"]);
    expect(exportResult.exitCode).toBe(0);
    const exportedFiles = fs.readdirSync(path.join(project.dir, "data", "notes"));
    expect(exportedFiles.some((f) => f.includes(noteId))).toBe(true);

    // history shows the lifecycle
    const historyResult = await runCli(["history", noteId]);
    expect(historyResult.exitCode).toBe(0);
    expect(historyResult.stdout).toContain("note_created");
    expect(historyResult.stdout).toContain("note_verified");
  });

  it("supports propose -> approve via markdown re-import against a verified note", async () => {
    await runCli(["init"]);
    const seedDir = path.join(project.dir, "seed");
    writeSeedFile(seedDir, "refund.md", seedMarkdown);
    await runCli(["import", seedDir]);
    const [noteId] = readNoteIds(project.dir, { status: "draft" });
    await runCli(["approve", noteId, "--actor", "human:reviewer", "--reason", "ok"]);

    // Re-import with an id + changed body -> should create a proposal, not mutate the verified note directly.
    const updated = seedMarkdown
      .replace('summary: "返金は購入から30日以内であれば全額対応します。詳細は下記を参照してください。"', `id: "${noteId}"\nsummary: "返金は購入から30日以内であれば全額対応します。詳細は下記を参照してください。"`)
      .replace("30日以内であれば返金可能です。", "30日以内であれば返金可能です。特例として60日まで延長できる場合があります。");
    writeSeedFile(seedDir, "refund.md", updated);

    const reimportResult = await runCli(["import", seedDir]);
    expect(reimportResult.exitCode).toBe(0);
    expect(reimportResult.stdout).toContain("proposal: 1");

    const proposalIds = readProposalIds(project.dir);
    expect(proposalIds).toHaveLength(1);

    const showProposal = await runCli(["show", proposalIds[0]]);
    expect(showProposal.exitCode).toBe(0);
    expect(showProposal.stdout).toContain("target note:");
    expect(showProposal.stdout).toContain("diff:");

    const approveProposal = await runCli(["approve", proposalIds[0], "--actor", "human:reviewer2", "--reason", "approved"]);
    expect(approveProposal.exitCode).toBe(0);
    expect(approveProposal.stdout).toContain("Approved");

    const showNote = await runCli(["show", noteId]);
    expect(showNote.stdout).toContain("特例として60日まで延長");
  });

  it("distinguishes an archive_recommendation proposal in list --pending / show, and approving it archives the note", async () => {
    await runCli(["init"]);
    const seedDir = path.join(project.dir, "seed");
    writeSeedFile(seedDir, "refund.md", seedMarkdown);
    await runCli(["import", seedDir]);
    const [noteId] = readNoteIds(project.dir, { status: "draft" });
    await runCli(["approve", noteId, "--actor", "human:reviewer", "--reason", "ok"]);

    // recommend_archive is MCP-only (agent-facing); simulate what the MCP tool does by
    // calling the same core service directly against the CLI's own project dir/db.
    const agentCtx = createContext({ actor: "agent:codex" });
    let proposalId: string;
    try {
      const reviews = createReviewService(agentCtx);
      const { proposal } = reviews.createArchiveRecommendation({
        note_id: noteId,
        reason: "2026年の制度改定により内容が古くなったため",
      });
      proposalId = proposal.id;
    } finally {
      agentCtx.db.close();
    }

    const pendingResult = await runCli(["list", "--pending"]);
    expect(pendingResult.exitCode).toBe(0);
    expect(pendingResult.stdout).toContain(proposalId);
    expect(pendingResult.stdout).toContain("proposal:archive");
    expect(pendingResult.stdout).toContain("Archive recommendation");

    const showResult = await runCli(["show", proposalId]);
    expect(showResult.exitCode).toBe(0);
    expect(showResult.stdout).toContain("ARCHIVE RECOMMENDATION");
    expect(showResult.stdout).toContain("2026年の制度改定により内容が古くなったため");

    const approveResult = await runCli(["approve", proposalId, "--actor", "human:reviewer2", "--reason", "confirmed"]);
    expect(approveResult.exitCode).toBe(0);
    expect(approveResult.stdout).toContain("Approved");

    const archivedIds = readNoteIds(project.dir, { status: "archived" });
    expect(archivedIds).toEqual([noteId]);
  });
});
