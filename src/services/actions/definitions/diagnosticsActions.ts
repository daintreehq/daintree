import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";

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
}
