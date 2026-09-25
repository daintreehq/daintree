import { buildDefaultKeybindings } from "@shared/config/defaultKeybindings";
import { describeChord, parseChord } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import type { TourChapter } from "@daintreehq/tour";
import type { TourKeyboard } from "@daintreehq/tour/kit";

/**
 * The two keyboards the tour is voiced for. Windows and Linux share every
 * default the tour mentions (the Windows-only rows are Ctrl+F4 additions), and
 * their keys are named the same aloud, so one reading serves both.
 */
export type { TourKeyboard };

export const TOUR_KEYBOARDS: readonly TourKeyboard[] = ["mac", "pc"];

/** `{{action.id}}` speaks that action's default shortcut; `{{Alt+Enter}}` a fixed key. */
const KEY_TOKEN = /\{\{([^{}]+)\}\}/g;

/** Modifiers then one key, chord steps space-separated: "Alt+Enter", "Cmd+K T". */
const LITERAL_COMBO =
  /^(?:(?:Cmd|Ctrl|Alt|Shift)\+)*(?:[A-Z0-9]|Enter|Escape|Tab|Space|F\d{1,2})(?: (?:(?:Cmd|Ctrl|Alt|Shift)\+)*(?:[A-Z0-9]|Enter|Escape|Tab|Space|F\d{1,2}))*$/;

const DEFAULT_COMBOS = new Map<string, string>();
for (const binding of buildDefaultKeybindings(false)) {
  if (binding.combo && !DEFAULT_COMBOS.has(binding.actionId)) {
    DEFAULT_COMBOS.set(binding.actionId, binding.combo);
  }
}

export function currentTourKeyboard(): TourKeyboard {
  return isMac() ? "mac" : "pc";
}

/**
 * The combo a token names. The narration is prerecorded, so it can only ever
 * speak the shipped default — never a user's override.
 */
export function tourCombo(token: string): string {
  const combo = DEFAULT_COMBOS.get(token);
  if (combo) return combo;
  if (LITERAL_COMBO.test(token)) return token;
  throw new Error(`Tour shortcut "${token}" is neither a default keybinding nor a key combo`);
}

/** The shortcut as the voice says it: "Command Shift P", "Control Shift P". */
export function spokenCombo(combo: string, keyboard: TourKeyboard): string {
  // describeChord is the screen-reader wording; a voice can't be trusted to
  // expand "Ctrl" the way a screen reader does.
  return describeChord(combo, keyboard === "mac").replace(/\bCtrl\b/g, "Control");
}

/**
 * One keycap per key, as the app's own shortcut chips draw them. Takes the same
 * token the narration names the shortcut by, so the two can't disagree.
 */
export function tourKeycaps(token: string, keyboard: TourKeyboard): string[] {
  const steps = parseChord(tourCombo(token), keyboard === "mac");
  // One row of caps can't show "then"; a chord belongs in a hint instead.
  if (steps.length !== 1)
    throw new Error(`Tour keycaps take a single-step shortcut, not "${token}"`);
  return steps[0]!;
}

/** A menu row's shortcut hint: "⌘⇧P" on a Mac, "Ctrl+Shift+P" elsewhere. */
export function tourShortcutHint(token: string, keyboard: TourKeyboard): string {
  return parseChord(tourCombo(token), keyboard === "mac")
    .map((keys) => keys.join(keyboard === "mac" ? "" : "+"))
    .join(" ");
}

export function hasKeyTokens(text: string): boolean {
  return new RegExp(KEY_TOKEN.source).test(text);
}

/** Replace every `{{…}}` shortcut token with its spoken form for this keyboard. */
export function resolveKeyTokens(text: string, keyboard: TourKeyboard): string {
  return text.replace(KEY_TOKEN, (_match, token: string) =>
    spokenCombo(tourCombo(token.trim()), keyboard)
  );
}

export interface TourNarrationVariant {
  /** Manifest key: the chapter id, suffixed with the keyboard when the chapter speaks a shortcut. */
  key: string;
  keyboards: readonly TourKeyboard[];
  narration: string;
}

/**
 * The distinct recordings a chapter needs. A chapter that names a shortcut is
 * voiced once per keyboard, each with its own word timings; the rest are
 * voiced once and shared.
 */
export function narrationVariants(chapter: TourChapter): TourNarrationVariant[] {
  if (!hasKeyTokens(chapter.narration)) {
    return [{ key: chapter.id, keyboards: TOUR_KEYBOARDS, narration: chapter.narration }];
  }
  return TOUR_KEYBOARDS.map((keyboard) => ({
    key: `${chapter.id}.${keyboard}`,
    keyboards: [keyboard],
    narration: resolveKeyTokens(chapter.narration, keyboard),
  }));
}

export function narrationVariant(
  chapter: TourChapter,
  keyboard: TourKeyboard
): TourNarrationVariant {
  return narrationVariants(chapter).find((variant) => variant.keyboards.includes(keyboard))!;
}
