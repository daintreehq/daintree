import { create } from "zustand";

/**
 * What the pill is reporting. `typing` is the type-anywhere locate/rescue;
 * the two `file-*` kinds are the file-reference receipts. The kind decides how
 * long the pill dwells and whether it carries the refusal glyph.
 */
export type TypingLocatorKind = "typing" | "file-added" | "file-refused";

export interface TypingLocatorMessage {
  kind: TypingLocatorKind;
  /** The fixed phrase ("Typing into"). Never truncated. */
  lead: string;
  /** The destination pane's title. The only part allowed to truncate. */
  target?: string;
}

/** The message as one sentence, for announcements and logs. */
export function formatTypingLocatorMessage(message: TypingLocatorMessage): string {
  return message.target === undefined ? message.lead : `${message.lead} ${message.target}`;
}

/**
 * Transient "here is where your typing is going" label (#11134).
 *
 * Deliberately not routed through `notify()`: this is ephemeral typing
 * feedback the user is already looking for, not an event they could otherwise
 * miss, and it must leave no inbox history. The grid-bar and InlineStatusBanner
 * surfaces are both wrong for the same reason — they are for runtime signals
 * with recovery actions.
 */
interface TypingLocatorState {
  message: TypingLocatorMessage | null;
  /** Bumped on every show so a repeat locator for the same pane restarts the dwell. */
  revision: number;
  showLocator: (message: TypingLocatorMessage) => void;
  clearLocator: () => void;
}

export const useTypingLocatorStore = create<TypingLocatorState>()((set) => ({
  message: null,
  revision: 0,
  showLocator: (message) => set((s) => ({ message, revision: s.revision + 1 })),
  clearLocator: () => set({ message: null }),
}));
