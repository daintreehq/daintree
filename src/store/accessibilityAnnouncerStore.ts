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
      priority: priority === "assertive" ? "important" : "normal",
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
