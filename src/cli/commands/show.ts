import type { Command } from "commander";
import { createContext, type AppContext } from "../../core/context.js";
import { createNoteService } from "../../core/notes.js";
import { createReviewService } from "../../core/reviews.js";
import { createPolicyService } from "../../core/policy.js";
import { KahanyakuError } from "../../core/errors.js";
import { handleError } from "../context.js";
import { renderNoteDetail, renderProposalDetail } from "../render.js";

export function registerShowCommand(program: Command): void {
  const cmd = program
    .command("show <id>")
    .description("Show a note (note_...) or an update proposal (proposal_...) in full")
    .action(async (id: string) => {
      let ctx: AppContext | undefined;
      try {
        ctx = createContext({});
        if (id.startsWith("note_")) {
          const notes = createNoteService(ctx);
          const note = notes.getNoteForReview(id);
          // Only draft/rejected notes are still subject to checkDraft's warnings
          // (verified/archived already passed review); this is what puts the ⚠
          // flag on `list --pending`, surfaced here so a reviewer can see why.
          const policyWarnings =
            note.status === "draft" || note.status === "rejected"
              ? createPolicyService(ctx).checkDraft({
                  summary: note.summary,
                  body: note.body,
                  tags: note.tags,
                  confidence: note.confidence,
                  sources: note.sources.map((s) => ({ type: s.type })),
                })
              : [];
          console.log(renderNoteDetail(note, policyWarnings));
        } else if (id.startsWith("proposal_")) {
          const reviews = createReviewService(ctx);
          const item = reviews.getReviewItem(id);
          console.log(renderProposalDetail(item));
        } else {
          throw new KahanyakuError("not_found", `${id} is not a recognized note_ or proposal_ id`, { details: { id } });
        }
      } catch (err) {
        handleError(cmd, err);
      } finally {
        ctx?.db.close();
      }
    });
}
