import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");

const CRITICAL_THEME_FILES = [
  "src/components/Browser/BrowserPane.tsx",
  "src/components/Browser/BrowserToolbar.tsx",
  "src/components/Browser/ConsolePanel.tsx",
  "src/components/DevPreview/ConsoleDrawer.tsx",
  "src/components/DevPreview/DevPreviewPane.tsx",
  "src/components/Layout/Toolbar.tsx",
  "src/components/Project/ProjectSwitcher.tsx",
  "src/components/Project/QuickRun.tsx",
  "src/components/Terminal/HybridInputBar.tsx",
  "src/components/Terminal/XtermAdapter.tsx",
  "src/components/Worktree/WorktreeCard/WorktreeHeader.tsx",
  "src/components/Worktree/WorktreeCard/WorktreeDetailsSection.tsx",
  "src/components/Worktree/WorktreeCard/WorktreeTerminalSection.tsx",
] as const;

const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bbg-white(?:\/[^\s"'`)]+)?\b/, "white-backed surfaces break light themes"],
  [/\bbg-black(?:\/[^\s"'`)]+)?\b/, "black-backed surfaces bypass theme tokens"],
  [/\btext-white(?:\/[^\s"'`)]+)?\b/, "white text in app chrome bypasses theme tokens"],
  [/\bhover:text-white(?:\/[^\s"'`)]+)?\b/, "hover states should use theme text tokens"],
  [/focus:border-white\/20/, "focus borders should resolve through theme tokens"],
];

describe("theme readiness contract", () => {
  for (const relativePath of CRITICAL_THEME_FILES) {
    it(`${relativePath} avoids dark-only hardcoded chrome styles`, () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

      for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
        expect(source, `${relativePath}: ${reason}`).not.toMatch(pattern);
      }
    });
  }
});
