import { create } from "zustand";

interface AnnouncementEntry {
  msg: string;
  id: number;
}

interface AnnouncerState {
  polite: AnnouncementEntry | null;
  assertive: AnnouncementEntry | null;
  nextId: number;
  announce: (msg: string, priority?: "polite" | "assertive") => void;
}

// Module-scoped record of the latest delivered entry id per channel.
// Lets co-located `AccessibilityAnnouncer` instances coordinate so a
// modal that mounts after an announcement was already delivered doesn't
// replay the stale entry into its newly focused subtree.
const deliveredIds: { polite: number; assertive: number } = { polite: 0, assertive: 0 };

export function isDelivered(channel: "polite" | "assertive", id: number): boolean {
  return deliveredIds[channel] >= id;
}

export function markDelivered(channel: "polite" | "assertive", id: number): void {
  if (id > deliveredIds[channel]) deliveredIds[channel] = id;
}

export function _resetAnnouncerDeliveryForTests(): void {
  deliveredIds.polite = 0;
  deliveredIds.assertive = 0;
}

// VoiceOver on macOS ignores `aria-live` updates outside the focused
// `aria-modal="true"` dialog's DOM subtree (Chromium 354736464). The
// native `document.ariaNotify` API (Chrome 141+ / Chromium 146) queues
// announcements directly with the platform AT, bypassing the subtree
// filter entirely. Feature-detect at call time so test/SSR contexts
// without a document object still work.
function tryAriaNotify(msg: string, priority: "polite" | "assertive"): boolean {
  if (typeof document === "undefined") return false;
  const notify = document.ariaNotify;
  if (typeof notify !== "function") return false;
  try {
    notify.call(document, msg, {
      priority: priority === "assertive" ? "high" : "normal",
    });
    return true;
  } catch {
    return false;
  }
}

export const useAnnouncerStore = create<AnnouncerState>((set) => ({
  polite: null,
  assertive: null,
  nextId: 1,
  announce: (msg, priority = "polite") => {
    if (tryAriaNotify(msg, priority)) return;
    set((state) => {
      const id = state.nextId;
      if (priority === "assertive") {
        return { nextId: id + 1, assertive: { msg, id } };
      }
      return { nextId: id + 1, polite: { msg, id } };
    });
  },
}));
