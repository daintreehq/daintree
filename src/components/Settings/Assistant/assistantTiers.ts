import type { HelpAssistantTier } from "@shared/types";

export const TIER_SHORT_LABEL: Record<HelpAssistantTier, string> = {
  core: "Core",
  full: "Full",
};

export const TIER_RANK: Record<HelpAssistantTier, number> = {
  core: 0,
  full: 1,
};
