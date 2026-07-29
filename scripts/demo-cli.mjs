#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(repoRoot, "dist", "cli", "index.js");
const exampleVault = path.join(repoRoot, "examples", "support-vault");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "citehanko-demo-"));
const demoVault = path.join(dataDir, "examples", "support-vault");

function run(args, { show = true } = {}) {
  const command = `citehanko ${args.join(" ")}`;
  if (show) console.log(`\n$ ${command}`);

  try {
    const output = execFileSync(process.execPath, [cliEntry, ...args], {
      cwd: dataDir,
      env: { ...process.env, CITEHANKO_HOME: dataDir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (show && output.trim()) console.log(output.trimEnd());
    return output;
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

try {
  if (!fs.existsSync(cliEntry)) {
    throw new Error(`Build output not found: ${cliEntry}. Run npm run build first.`);
  }

  console.log("CiteHanko verified-context demo (temporary SQLite workspace)");

  run(["init", "--data-dir", dataDir]);

  const configPath = path.join(dataDir, "citehanko.config.yaml");
  const demoConfig = fs
    .readFileSync(configPath, "utf8")
    .replace("reviewer_separation: warn", "reviewer_separation: enforce")
    .replace("scope_reviewers: warn", "scope_reviewers: enforce")
    .replace("reviewers: []", "reviewers: [human:demo-reviewer]");
  if (
    !demoConfig.includes("reviewer_separation: enforce") ||
    !demoConfig.includes("scope_reviewers: enforce") ||
    !demoConfig.includes("reviewers: [human:demo-reviewer]")
  ) {
    throw new Error("Could not configure the demo reviewer policy.");
  }
  fs.writeFileSync(configPath, demoConfig);
  console.log("Demo policy: separate reviewer required; support reviewer = human:demo-reviewer");

  fs.mkdirSync(path.dirname(demoVault), { recursive: true });
  fs.cpSync(exampleVault, demoVault, { recursive: true });
  run(["import", "examples/support-vault"]);

  console.log("\n--- Before human review: drafts are not returned as official context ---");
  run(["search", "返金"]);

  const pending = run(["list", "--pending"], { show: false });
  const refundLine = pending.split("\n").find((line) => line.includes("返金ポリシー"));
  const noteId = refundLine?.match(/\bnote_[0-9A-Z]+\b/)?.[0];
  if (!noteId) throw new Error("Could not find the refund-policy draft in the review queue.");

  console.log("\n--- Human review step (CLI only) ---");
  run([
    "approve",
    noteId,
    "--actor",
    "human:demo-reviewer",
    "--reason",
    "demo: content and source reviewed",
  ]);

  console.log("\n--- After approval: verified context is returned with a citation ---");
  const searchAfterApproval = run(["search", "返金"]);
  if (!searchAfterApproval.includes(noteId) || !searchAfterApproval.includes("status=verified")) {
    throw new Error("The approved note was not returned as verified context.");
  }

  console.log("\nDemo passed: draft -> human approval -> verified search result.");
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
