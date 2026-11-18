import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "./define.ts";
import { FIXTURE_CHANNELS } from "./preload.ts";
import type { CommandPayload, CommandResult } from "./maps.ts";

const PayloadSchema = z.object({
  commandId: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

async function handleNoArgs(): Promise<number> {
  return 42;
}

async function handleStringArg(name: string): Promise<void> {
  void name;
}

async function handleMultiArg(id: string, count: number): Promise<boolean> {
  void id;
  return count > 0;
}

async function handleObjectResult(): Promise<{ value: string; ok: true }> {
  return { value: "hi", ok: true };
}

async function handleValidated(payload: CommandPayload): Promise<CommandResult> {
  void payload;
  return { ok: true };
}

export const topLevelNamespace = defineIpcNamespace({
  name: "fixture-top",
  ops: {
    noArgs: op(FIXTURE_CHANNELS.noArgs, handleNoArgs),
    stringArg: op(FIXTURE_CHANNELS.stringArg, handleStringArg),
    multiArg: op(FIXTURE_CHANNELS.multiArg, handleMultiArg),
    objectResult: op(FIXTURE_CHANNELS.objectResult, handleObjectResult),
    validated: opValidated(FIXTURE_CHANNELS.validated, PayloadSchema, handleValidated),
    withContext: op(
      FIXTURE_CHANNELS.withContext,
      async (_ctx: { id: number }, id: string): Promise<void> => {
        void id;
      },
      { withContext: true }
    ),
  },
});

export function registerInsideFn() {
  // Mirrors scratch/index.ts where defineIpcNamespace is called
  // inside a function body, often with inline arrow handlers.
  return defineIpcNamespace({
    name: "fixture-fn",
    ops: {
      insideFn: op(FIXTURE_CHANNELS.insideFn, async (): Promise<string[]> => {
        return ["alpha", "beta"];
      }),
    },
  });
}
