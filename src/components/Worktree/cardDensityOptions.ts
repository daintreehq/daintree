import type { CardDensity } from "@/store/worktreeFilterStore";

/** One list for the sidebar's View menu and the Settings row, so the two never disagree. */
export const CARD_DENSITY_OPTIONS = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
] as const satisfies readonly { value: CardDensity; label: string }[];

export const DEFAULT_CARD_DENSITY: CardDensity = "comfortable";
