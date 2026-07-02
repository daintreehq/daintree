import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

const scopeSchema = z.object({
  timeWindowMs: z.number().int().positive().optional(),
  source: z.string().optional(),
  sections: z.array(z.string()).optional(),
});

const argsSchema = z.object({ scope: scopeSchema.optional() }).optional();

export function registerDiagnosticsActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("diagnostics.openReview", () => ({
    id: "diagnostics.openReview",
    title: "Send diagnostics",
    description:
      "Collect a diagnostics snapshot and open the review dialog for export. Optional scope hint (timeWindowMs, sections) pre-selects which sections to include.",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema,
    run: async (args: unknown) => {
      // Parse rather than cast so the lint ratchet doesn't grow the
      // `no-unsafe-type-assertion` baseline; the dispatcher already validates
      // via argsSchema, so this is effectively a typed re-derive.
      const parsed = argsSchema.parse(args);
      await useDiagnosticsReviewStore.getState().openReview(parsed?.scope);
    },
  }));

  actions.set("diagnostics.openWhySlow", () => ({
    id: "diagnostics.openWhySlow",
    title: "Why am I slow?",
    description:
      "Open the diagnostics dock to the performance snapshot: current resource profile and why it triggered, event-loop lag latch, focus throttle, terminal WebGL mode, PTY backpressure, and worktree monitor load.",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: () => {
      useDiagnosticsStore.getState().openDock("whySlow");
    },
  }));
}
