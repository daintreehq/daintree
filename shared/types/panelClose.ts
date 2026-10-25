import { z } from "zod";

/**
 * What the pty-host reported about a closed panel's process when the close
 * returned (#14474). A close trashes the panel and its process keeps running
 * through the trash grace, so `closedIds` alone says nothing about the process.
 * Main reads these after the close; the renderer never produces them.
 */
export const ClosedPanelProcessSchema = z.object({
  terminalId: z.string(),
  exited: z
    .boolean()
    .nullable()
    .describe("true: the host saw the process exit. false: not yet. null: no process record."),
  trashExpiresAt: z
    .number()
    .nullable()
    .describe("When the trash grace ends and the host starts stopping it, unless restored (ms)."),
});

export type ClosedPanelProcess = z.infer<typeof ClosedPanelProcessSchema>;

export const PanelCloseResultSchema = z.object({
  closedIds: z
    .array(z.string())
    .describe(
      "Panels closed. Empty means nothing closed (none to act on, already in the trash, or teardown failed): treat it as a failed close."
    ),
  processes: z
    .array(ClosedPanelProcessSchema)
    .optional()
    .describe(
      "Each closed panel's process as the host saw it after the close. A closed panel's process can still be running."
    ),
});
