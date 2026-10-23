import { create } from "zustand";

/**
 * Why this view's project offers the dev preview by default (#14069), the
 * first that holds:
 *
 * - `always` — the app-wide "Always show dev preview" is on.
 * - `pinned` — the user pinned its button to the toolbar themselves.
 * - `in-use` — a dev preview is open, or its server is running.
 * - `command` — the project has a dev server command.
 * - `web-project` — the project's files look like a web project.
 * - `unknown` — main hasn't read the files, or couldn't; offered, as every
 *   project was before.
 * - `null` — nothing says the project wants it, so its entry points stay out
 *   of the way until the user shows them in this project.
 *
 * Only a default: the project's own level beats every one of these.
 */
export type DevPreviewOfferReason =
  "always" | "pinned" | "in-use" | "command" | "web-project" | "unknown" | null;

export interface DevPreviewOfferFacts {
  alwaysShow: boolean;
  pinned: boolean;
  inUse: boolean;
  commandConfigured: boolean;
  webProject: boolean | null;
}

export function devPreviewOfferReason(facts: DevPreviewOfferFacts): DevPreviewOfferReason {
  if (facts.alwaysShow) return "always";
  if (facts.pinned) return "pinned";
  if (facts.inUse) return "in-use";
  if (facts.commandConfigured) return "command";
  if (facts.webProject === true) return "web-project";
  return facts.webProject === null ? "unknown" : null;
}

interface DevPreviewOfferState {
  reason: DevPreviewOfferReason;
}

/**
 * Written only by `useDevPreviewOfferSync`, so the stores behind it are read
 * once per view rather than by every worktree card that resolves the profile.
 * Starts unknown: a surface drawn before that hook runs keeps today's default.
 */
export const useDevPreviewOfferStore = create<DevPreviewOfferState>(() => ({
  reason: "unknown",
}));
