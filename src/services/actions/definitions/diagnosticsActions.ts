import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

const scopeSchema = z.object({
  timeWindowMs: z.number().int().positive().optional(),
  source: z.string().optional(),
  sections: z
    .array(z.string())
    .optional()
    .describe("Section keys to pre-select; every other section starts unchecked. Omit for all."),
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
      "Collect a diagnostics snapshot and open the review dialog, where the user picks sections and adds redaction rules before saving the export themselves. The way to hand logs to someone else: nothing leaves the machine from this call.",
    paletteDescription: "Collect diagnostics and choose what to include and redact before saving",
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
      // The store keeps a collection failure for the Settings row and resolves;
      // without this a caller would report a dialog that never opened.
      const { downloadError } = useDiagnosticsReviewStore.getState();
      if (downloadError) throw new Error(downloadError);
    },
  }));

  actions.set("diagnostics.openWhySlow", () => ({
    id: "diagnostics.openWhySlow",
    title: "Why am I slow?",
    description:
      "Open the diagnostics dock to the performance snapshot: current resource profile and why it triggered, event-loop lag latch, focus throttle, terminal WebGL mode, PTY backpressure, and worktree monitor load.",
    paletteDescription:
      "See the performance snapshot: resource profile, event-loop lag and terminal load",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().openDock("whySlow");
    },
  }));
}
