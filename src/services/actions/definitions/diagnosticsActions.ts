import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";

const scopeSchema = z.object({
  timeWindowMs: z.number().int().positive().optional(),
  source: z.string().optional(),
  sections: z.array(z.string()).optional(),
});

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
    argsSchema: z.object({ scope: scopeSchema.optional() }).optional(),
    run: async (args: unknown) => {
      const parsed = (args as { scope?: z.infer<typeof scopeSchema> } | undefined) ?? {};
      await useDiagnosticsReviewStore.getState().openReview(parsed.scope);
    },
  }));
}
