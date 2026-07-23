// Generates docs/keyboard-shortcuts.md from shared/config/defaultKeybindings.ts.
// Run: npm run codegen:keybindings   Verify (CI): npm run check:keybindings
// Platform-parameterized on purpose: the generator emits both the macOS and
// Windows/Linux variants regardless of the host OS it runs on.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildDefaultKeybindings } from "../../shared/config/defaultKeybindings.js";
import type { KeybindingConfig } from "../../shared/types/keybinding.js";

const DOC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/keyboard-shortcuts.md"
);

const CATEGORY_ORDER = [
  "Navigation",
  "Terminal",
  "Agents",
  "Fleet",
  "Worktrees",
  "Worktree Sessions",
  "Panels",
  "Portal",
  "Dev Preview",
  "Project",
  "Git",
  "Search",
  "View",
  "Layout",
  "Voice",
  "Help",
  "App",
  "System",
];

function displayMac(combo: string): string {
  return combo
    .replace(/Cmd\+/g, "⌘+")
    .replace(/Ctrl\+/g, "⌃+")
    .replace(/Shift\+/g, "⇧+")
    .replace(/Alt\+/g, "⌥+");
}

function displayWin(combo: string): string {
  return combo.replace(/Cmd\+/g, "Ctrl+");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function generate(): string {
  const core = buildDefaultKeybindings(false);
  const windows = buildDefaultKeybindings(true);
  const windowsOnly = windows.filter((b) => !core.includes(b));

  const byCategory = new Map<string, KeybindingConfig[]>();
  const add = (binding: KeybindingConfig) => {
    const category = binding.category ?? "Other";
    const list = byCategory.get(category) ?? [];
    list.push(binding);
    byCategory.set(category, list);
  };
  core.filter((b) => b.combo).forEach(add);
  windowsOnly.filter((b) => b.combo).forEach(add);

  const categories = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
  ];

  const lines: string[] = [];
  lines.push(
    "<!-- GENERATED FILE — DO NOT EDIT. Regenerate with `npm run codegen:keybindings` (source: shared/config/defaultKeybindings.ts). -->"
  );
  lines.push("");
  lines.push("# Keyboard shortcuts");
  lines.push("");
  lines.push(
    "Default keyboard shortcuts shipped with Daintree. This page lists defaults only — your effective bindings (including any rebinds, plugin contributions, and import profiles) live in the in-app reference: press `⌘+/` (`Ctrl+/`), `⌘+K ⌘+S`, or open Help → Keyboard Shortcuts."
  );
  lines.push("");
  lines.push("## Conventions");
  lines.push("");
  lines.push(
    "- `Cmd` means ⌘ on macOS and `Ctrl` on Windows/Linux; the tables below show both forms."
  );
  lines.push(
    "- Chords are two keystrokes in sequence: `⌘+K ⌘+S` means press `⌘+K`, release, then `⌘+S`. Press `⌘+K` alone to see every completion in the command HUD; Escape cancels."
  );
  lines.push(
    "- While a terminal has focus, only modifier-bearing shortcuts fire — bare keys, arrows, and Escape always reach the terminal. The readline keys `Ctrl+P/N/R/F/B/A/E/K/U/W/H/D` are always passed through to the terminal, as are the Windows/Linux clipboard keys `Ctrl+Shift+C`, `Ctrl+Shift+V`, and `Shift+Insert`."
  );
  lines.push(
    "- Every shortcut here can be rebound in Settings → Keyboard, which also supports export/import of shortcut profiles and per-row reset."
  );
  lines.push("");

  for (const category of categories) {
    const bindings = byCategory.get(category);
    if (!bindings || bindings.length === 0) continue;
    lines.push(`## ${category}`);
    lines.push("");
    lines.push("| Action | macOS | Windows/Linux |");
    lines.push("| --- | --- | --- |");
    for (const binding of bindings) {
      const isWindowsOnly = windowsOnly.includes(binding);
      const label = escapeCell(binding.description ?? binding.actionId);
      const mac = isWindowsOnly ? "—" : `\`${escapeCell(displayMac(binding.combo))}\``;
      const win = `\`${escapeCell(displayWin(binding.combo))}\`${isWindowsOnly ? " (Windows only)" : ""}`;
      lines.push(`| ${label} | ${mac} | ${win} |`);
    }
    lines.push("");
  }

  lines.push("## Fixed keys");
  lines.push("");
  lines.push(
    "A few interactions are fixed and not rebindable: worktree-list navigation (arrows, `j`/`k`, Home/End, Enter/Space, `e` for editor), keyboard drag-and-drop reordering (Space to pick up, arrows to move), and `Alt+Up`/`Alt+Down` worktree reordering in the sidebar."
  );
  lines.push("");
  return lines.join("\n");
}

const expected = generate();
const isCheck = process.argv.includes("--check");

if (isCheck) {
  let actual = "";
  try {
    actual = readFileSync(DOC_PATH, "utf-8");
  } catch {
    // Missing file fails the check below.
  }
  if (actual !== expected) {
    console.error(
      "docs/keyboard-shortcuts.md is stale. Run `npm run codegen:keybindings` and commit the result."
    );
    process.exit(1);
  }
  console.log("docs/keyboard-shortcuts.md is up to date.");
} else {
  writeFileSync(DOC_PATH, expected);
  console.log("Wrote docs/keyboard-shortcuts.md");
}
