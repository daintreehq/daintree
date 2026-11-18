import type { DangerousMode, PermissionLevel } from "@shared/types/agentSettings";

/** What a resolved launch does about permission prompts, in the words Settings uses. */
export const PERMISSION_LEVEL_LABELS: Record<PermissionLevel, string> = {
  "cli-default": "CLI default",
  auto: "Auto",
  skip: "Skip all",
};

/** The level each explicit choice asks for, before agent support is applied. */
export const EXPLICIT_MODE_LABELS: Record<Exclude<DangerousMode, "inherit">, string> = {
  off: PERMISSION_LEVEL_LABELS["cli-default"],
  auto: PERMISSION_LEVEL_LABELS.auto,
  on: PERMISSION_LEVEL_LABELS.skip,
};
