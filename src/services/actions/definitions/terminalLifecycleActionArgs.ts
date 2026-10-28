import { z } from "zod";
import {
  MAX_KILL_BATCH_TERMINALS,
  TerminalKillBatchIdsSchema,
} from "@shared/types/terminalKillBatch";

export const RestartOnPresetArgsSchema = z.object({
  terminalId: z.string().optional(),
  presetId: z.string().min(1).describe("Preset of the terminal's own agent to respawn on."),
  confirmed: z
    .boolean()
    .optional()
    .describe("Confirms ending the conversation. Without it the terminal is left alone."),
});

export const TerminalKillBatchArgsSchema = z.object({
  terminalIds: TerminalKillBatchIdsSchema.describe(
    `Identifies the panels to destroy (1-${MAX_KILL_BATCH_TERMINALS}), using \`id\` values from the terminal listing. Each id must appear once. An id that is unchecked, already gone, or newly busy is reported back rather than failing the batch.`
  ),
});

export const SetHoldOnRestartArgsSchema = z.object({
  terminalId: z
    .string()
    .min(1)
    .describe("An agent terminal this plugin started with agent.launch."),
  hold: z.boolean().describe("False hands the terminal back to the resume setting."),
});
