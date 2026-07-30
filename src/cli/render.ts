import pc from "picocolors";
import type { NoteSummary, NoteWithDetail } from "../types/note.js";
import type { ReviewItem, ReviewItemDetail, ApproveResult, RejectResult } from "../types/proposal.js";
import type { HistoryEvent } from "../types/history.js";
import type { PolicyWarning } from "../types/policy.js";
import type { Citation } from "../core/citation.js";
import type { SearchResult } from "../core/search.js";
import type { ImportSummary, ExportSummary } from "../core/markdown.js";

export function renderPolicyWarnings(warnings: PolicyWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = [pc.yellow(`policy warnings (${warnings.length}):`)];
  for (const w of warnings) {
    lines.push(`  ⚠ ${w.code}: ${w.message} (${w.suggested_action})`);
  }
  return lines.join("\n");
}

export function renderCitation(citation: Citation): string {
  const stale = citation.stale ? " stale=true" : "";
  return `note_id=${citation.note_id} version=${citation.version} updated_at=${citation.updated_at}${stale}`;
}

export function renderNotesList(list: NoteSummary[]): string {
  if (list.length === 0) return "No notes found.";
  return list
    .map((n) => {
      const stale = n.stale ? pc.yellow(" [stale]") : "";
      return `${n.id}  [${n.status}]  scope=${n.scope ?? "-"}  ${n.title}${stale}`;
    })
    .join("\n");
}

export function renderPendingList(items: ReviewItem[]): string {
  if (items.length === 0) return "No pending review items.";

  const counts = new Map<string, number>();
  for (const item of items) {
    const key = `${item.scope ?? "(no scope)"} / ${item.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push(pc.bold("Pending review summary (scope / kind):"));
  for (const [key, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${key}: ${count}`);
  }
  lines.push("");
  lines.push(pc.bold(`${items.length} item(s), oldest first:`));
  for (const item of items) {
    const flags = [item.hasWarnings ? "⚠" : "", item.hasDuplicates ? "≈" : ""].filter(Boolean).join(" ");
    const kindLabel = item.proposalType === "archive_recommendation" ? `${item.kind}:archive` : item.kind;
    lines.push(
      `  ${item.id}  [${kindLabel}/${item.status}]  scope=${item.scope ?? "-"}  ${item.title}${flags ? "  " + flags : ""}  (${item.createdAt})`,
    );
  }
  return lines.join("\n");
}

export function renderNoteDetail(note: NoteWithDetail, policyWarnings: PolicyWarning[] = []): string {
  const lines: string[] = [];
  lines.push(`${pc.bold(note.title)}  (${note.id})`);
  lines.push(
    `status: ${note.status}${note.stale ? pc.yellow(" [STALE]") : ""}   version: ${note.version}   confidence: ${note.confidence}`,
  );
  lines.push(`scope: ${note.scope ?? "-"}   owner: ${note.owner ?? "-"}`);
  lines.push(`created_by: ${note.createdBy}   reviewed_by: ${note.reviewedBy ?? "-"}`);
  lines.push(`created_at: ${note.createdAt}   updated_at: ${note.updatedAt}`);
  if (note.reviewDueAt) lines.push(`review_due_at: ${note.reviewDueAt}`);
  if (note.draftReason) lines.push(`draft_reason: ${note.draftReason}`);
  if (note.rejectionReason) lines.push(`rejection_reason: ${note.rejectionReason}`);
  lines.push(`tags: ${note.tags.length > 0 ? note.tags.join(", ") : "-"}`);
  if (note.sources.length > 0) {
    lines.push("sources:");
    for (const s of note.sources) {
      const bits = [s.title ? `"${s.title}"` : null, s.url, s.path, s.commitSha].filter(Boolean).join(" ");
      lines.push(`  - ${s.type}${bits ? ` ${bits}` : ""}`);
    }
  }
  const warnings = renderPolicyWarnings(policyWarnings);
  if (warnings) lines.push(warnings);
  lines.push("");
  lines.push(`summary: ${note.summary}`);
  lines.push("");
  lines.push(note.body);
  return lines.join("\n");
}

export function renderProposalDetail(item: ReviewItemDetail): string {
  const isArchiveRecommendation = item.proposalType === "archive_recommendation";
  const lines: string[] = [];
  lines.push(
    `${pc.bold(item.id)}  status: ${item.status}${isArchiveRecommendation ? pc.yellow("  [ARCHIVE RECOMMENDATION]") : ""}`,
  );
  lines.push(`target note: ${item.targetNoteId ?? "-"}`);
  lines.push(`proposed_by: ${item.proposedBy ?? "-"}`);
  lines.push(`reason: ${item.reason ?? "-"}`);
  if (isArchiveRecommendation) {
    lines.push(
      "This is a recommendation to archive the target note (no content change). Approving it archives the note; approve/reject applies as usual.",
    );
  } else {
    lines.push(`changed_fields: ${item.changedFields?.join(", ") || "-"}`);
  }
  if (item.source && item.source.length > 0) lines.push(`source: ${JSON.stringify(item.source)}`);
  if (item.baseNoteVersion !== undefined) {
    lines.push(`base_note_version: ${item.baseNoteVersion}   current_note_version: ${item.currentNoteVersion}`);
  }
  if (item.suggestedAction) lines.push(pc.yellow(`suggested_action: ${item.suggestedAction}`));
  if (item.rejectionReason) lines.push(`rejection_reason: ${item.rejectionReason}`);
  const warnings = renderPolicyWarnings(item.policyWarnings);
  if (warnings) lines.push(warnings);
  if (item.diff) {
    lines.push("");
    lines.push("diff:");
    lines.push(item.diff);
  }
  return lines.join("\n");
}

export function renderApproveResult(result: ApproveResult): string {
  const lines: string[] = [];
  if (result.kind === "note") {
    lines.push(pc.green(`Approved. ${result.note.id} is now verified (version ${result.note.version}).`));
  } else {
    lines.push(
      pc.green(`Approved. Proposal ${result.proposal?.id} applied to ${result.note.id} (now version ${result.note.version}).`),
    );
  }
  if (result.cascadedNeedsRebase.length > 0) {
    lines.push(pc.yellow(`These proposals now need rebase: ${result.cascadedNeedsRebase.join(", ")}`));
  }
  const warnings = renderPolicyWarnings(result.policyWarnings);
  if (warnings) lines.push(warnings);
  return lines.join("\n");
}

export function renderRejectResult(result: RejectResult): string {
  return pc.green(`Rejected ${result.id} (${result.status}). reason: ${result.rejectionReason}`);
}

export function renderHistory(events: HistoryEvent[]): string {
  if (events.length === 0) return "No history found for this id.";
  return events
    .map((e) => {
      const reason = e.reason ? `  reason: ${e.reason}` : "";
      return `${e.createdAt}  ${pc.bold(e.eventType)}  actor=${e.actor} role=${e.role}${reason}`;
    })
    .join("\n");
}

export function renderSearchResult(result: SearchResult): string {
  if (result.noResults) {
    const lines = [`No results for "${result.query}".`];
    if (result.guidance) lines.push(pc.yellow(result.guidance));
    if (result.suggestedNextTools && result.suggestedNextTools.length > 0) {
      lines.push(`suggested next: ${result.suggestedNextTools.join(", ")}`);
    }
    return lines.join("\n");
  }
  return result.results
    .map((r) => {
      const stale = r.stale ? pc.yellow(" [stale]") : "";
      const score = r.score !== null ? `  score=${r.score.toFixed(2)}` : "";
      return [
        `${pc.bold(r.id)}  ${r.title}${stale}`,
        `  status=${r.status} confidence=${r.confidence} scope=${r.scope ?? "-"} matched=${r.matchedFields.join(",") || "-"}${score}`,
        `  ${r.snippet}`,
        `  citation: ${renderCitation(r.citation)}`,
      ].join("\n");
    })
    .join("\n\n");
}


export function renderExportSummary(summary: ExportSummary): string {
  return `Exported ${summary.exported} note(s) to ${summary.outDir}`;
}

export function renderImportSummary(summary: ImportSummary, scopeCounts: Map<string, number>): string {
  const lines: string[] = [];
  lines.push(
    `新規 draft: ${summary.createdDrafts} / update: ${summary.updatedDrafts} / proposal: ${summary.proposals} / skip: ${summary.skipped}`,
  );
  if (scopeCounts.size > 0) {
    lines.push("");
    lines.push("scope ごとの内訳:");
    for (const [scope, count] of [...scopeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${scope}: ${count}`);
    }
    lines.push("");
    lines.push("scope ごとに `kahanyaku list --pending --scope <scope>` でレビューしてください。");
  }
  if (summary.warnings.length > 0) {
    lines.push("");
    lines.push(pc.yellow(`warnings (${summary.warnings.length}):`));
    for (const w of summary.warnings) lines.push(`  ${w.file}: ${w.message}`);
  }
  return lines.join("\n");
}
