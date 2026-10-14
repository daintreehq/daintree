import { buildDefaultKeybindings } from "../config/defaultKeybindings.js";

/**
 * How shortcut overrides recorded on one machine read on another (#13346).
 *
 * Overrides are stored as literal combos ("Cmd+Alt+T"). Off a Mac, Cmd is the
 * Ctrl key, so a combo recorded on a Mac lands as its Ctrl twin on Linux or
 * Windows; and Linux moves some defaults off combinations its desktops claim
 * (Ctrl+Alt+T opens a terminal there). Neither is visible from the combo text.
 */

export type ShortcutPlatform = "mac" | "windows" | "linux";

export function shortcutPlatform(platform: string): ShortcutPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "linux";
}

const PLATFORM_NAMES: Record<ShortcutPlatform, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const COMMAND_TOKENS = new Set([
  "cmd",
  "command",
  "meta",
  "super",
  "commandorcontrol",
  "cmdorctrl",
]);
const CONTROL_TOKENS = new Set(["ctrl", "control"]);
const ALT_TOKENS = new Set(["alt", "option", "opt"]);
const MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift"];

function foldStroke(stroke: string, platform: ShortcutPlatform): string {
  const parts = stroke.split("+");
  // A trailing "+" is the plus key itself ("Cmd++"), not an empty token.
  const key = stroke.endsWith("++") ? "+" : (parts.pop() ?? "");
  const mods = new Set<string>();
  for (const raw of parts) {
    const token = raw.trim().toLowerCase();
    if (token === "") continue;
    if (COMMAND_TOKENS.has(token)) mods.add(platform === "mac" ? "cmd" : "ctrl");
    else if (CONTROL_TOKENS.has(token)) mods.add("ctrl");
    else if (ALT_TOKENS.has(token)) mods.add("alt");
    else mods.add(token);
  }
  const ordered = [...mods].sort((a, b) => {
    const ia = MODIFIER_ORDER.indexOf(a);
    const ib = MODIFIER_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return [...ordered, key.trim().toLowerCase()].join("+");
}

/** A combo in a form that compares equal to every spelling of the same keys on `platform`. */
export function foldCombo(combo: string, platform: ShortcutPlatform): string {
  return combo
    .trim()
    .split(/\s+/)
    .map((stroke) => foldStroke(stroke, platform))
    .join(" ");
}

/** The combo as someone at a `platform` machine would read it: Cmd becomes Ctrl off a Mac. */
export function comboAsReadOn(combo: string, platform: ShortcutPlatform): string {
  if (platform === "mac") return combo;
  return combo
    .trim()
    .split(/\s+/)
    .map((stroke) => {
      const parts = stroke.split("+");
      const key = stroke.endsWith("++") ? "+" : (parts.pop() ?? "");
      const seen = new Set<string>();
      const mods: string[] = [];
      for (const raw of parts) {
        if (raw === "") continue;
        const lower = raw.toLowerCase();
        const shown = COMMAND_TOKENS.has(lower) || CONTROL_TOKENS.has(lower) ? "Ctrl" : raw;
        if (seen.has(shown.toLowerCase())) continue;
        seen.add(shown.toLowerCase());
        mods.push(shown);
      }
      return [...mods, key].join("+");
    })
    .join(" ");
}

export interface ShortcutReading {
  /** The override's combos as they read on the target. */
  readsAs: string;
  /** Something to know before copying it there, or undefined when it reads the same and clashes with nothing. */
  note?: string;
}

const defaultsCache = new Map<
  ShortcutPlatform,
  Array<{ actionId: string; combo: string; description?: string }>
>();

function defaultsFor(platform: ShortcutPlatform) {
  let cached = defaultsCache.get(platform);
  if (!cached) {
    cached = buildDefaultKeybindings(platform === "windows", platform === "linux").map((b) => ({
      actionId: b.actionId,
      combo: b.combo,
      description: b.description,
    }));
    defaultsCache.set(platform, cached);
  }
  return cached;
}

/**
 * How `actionId`'s override `combos` reads on `target`, and the first thing
 * worth saying about it there: a combination Daintree keeps clear on that
 * platform for the desktop's own shortcuts, or one already bound there.
 */
export function readShortcutOn(
  actionId: string,
  combos: readonly string[],
  target: ShortcutPlatform
): ShortcutReading {
  const readsAs = combos.map((combo) => comboAsReadOn(combo, target)).join(", ");
  const targetDefaults = defaultsFor(target);
  const macDefaults = defaultsFor("mac");
  const name = PLATFORM_NAMES[target];

  for (const combo of combos) {
    if (combo.trim() === "") continue;
    const folded = foldCombo(combo, target);
    const shown = comboAsReadOn(combo, target);

    if (target !== "mac") {
      // A Mac default that folds to this combination but was moved on the
      // target: the platform keeps it for something outside Daintree.
      const moved = macDefaults.find((mac) => {
        if (mac.combo === "" || foldCombo(mac.combo, target) !== folded) return false;
        const here = targetDefaults.find((t) => t.actionId === mac.actionId);
        return here !== undefined && foldCombo(here.combo, target) !== folded;
      });
      if (moved) {
        return {
          readsAs,
          note: `${shown} is kept clear on ${name} for the desktop's own shortcuts`,
        };
      }
    }

    const clash = targetDefaults.find(
      (binding) =>
        binding.actionId !== actionId &&
        binding.combo !== "" &&
        foldCombo(binding.combo, target) === folded
    );
    if (clash) {
      return {
        readsAs,
        note: `${shown} is also ${clash.description ?? clash.actionId} on ${name}`,
      };
    }
  }

  const differs = combos.some((combo) => comboAsReadOn(combo, target) !== combo);
  return differs ? { readsAs, note: `Recorded as ${combos.join(", ")}` } : { readsAs };
}
