import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC = path.join(REPO_ROOT, "src");

// A whole card the user clicks — a quick action, a recovery choice, an agent to
// pick, a theme radio — renders through `ChoiceCard` / `choiceCardVariants`
// (`src/components/ui/card.tsx`). See "Choice cards" in
// docs/themes/interaction-state-recipes.md.
const CHOICE_CARD_SITES = [
  "components/Project/WelcomeScreen.tsx",
  "components/Recovery/CrashRecoveryDialog.tsx",
  "components/HelpPanel/HelpAssistantAgentChooser.tsx",
  "components/HelpPanel/HelpPanel.tsx",
  "components/Terminal/RecipeRunner/RecipeRunnerEmpty.tsx",
  "components/Terminal/RecipeRunner/RecipeRunnerItem.tsx",
  "components/Terminal/LauncherQuickActions.tsx",
  "components/Setup/AgentSetupWizard.tsx",
  "components/Portal/PortalLaunchpad.tsx",
  "components/Plugin/PluginCatalog.tsx",
];

// The primitives own the press recipe; everything else composes them or
// carries the hook.
const PRESS_OWNERS = new Set(["components/ui/button.tsx", "components/ui/card.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "__preview__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

/** Every single-line string or template literal — where class lists live. */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}

/** The className of every raw `<button>` / `<label>` opening tag. */
function rawCardClassNames(source: string): string[] {
  return [...source.matchAll(/<(?:button|label)\b[^>]*?className="([^"]*)"/g)].map((m) => m[1]!);
}

describe("choice cards contract", () => {
  it.each(CHOICE_CARD_SITES)("%s renders its cards through the primitive", (rel) => {
    expect(read(rel)).toMatch(/\b(ChoiceCard|choiceCardVariants)\b/);
  });

  // An outlined, rounded raw control in one of these files is a card rebuilt by
  // hand beside the primitive — the drift this contract exists to stop.
  it.each(CHOICE_CARD_SITES)("%s hand-rolls no outlined card", (rel) => {
    const offenders = rawCardClassNames(read(rel)).filter(
      (classes) => /\brounded-/.test(classes) && /(^|\s)(ring-1|border-border-)/.test(classes)
    );
    expect(offenders).toEqual([]);
  });

  // `active:scale-*` sets the individual `scale` property, which the reduced-
  // motion `transform: none` reset cannot reach; `press-scale` is the hook that
  // removes it. A press snap without it animates for users who asked for none.
  it("marks every hand-spelled press snap for reduced motion", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (PRESS_OWNERS.has(rel)) continue;
      for (const literal of stringLiterals(fs.readFileSync(file, "utf8"))) {
        if (!/active:scale-\[0\./.test(literal)) continue;
        if (!/(^|\s)press-scale(\s|$)/.test(literal)) {
          offenders.push(`${rel}: no press-scale: ${literal.slice(0, 60)}`);
        }
        // A transition list that names scale (or a bare `transition`, which
        // includes it) eases the release back instead of snapping it.
        if (
          /(^|\s)transition(-all|-transform|-\[[^\]]*(scale|transform)[^\]]*\])?(\s|$)/.test(
            literal
          )
        ) {
          offenders.push(`${rel}: eases the press: ${literal.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // An answer pair puts the safe answer first and the one filled primary last,
  // inline forms included — never "Submit, Cancel".
  it("never puts Cancel after the primary it answers beside", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith(".tsx")) continue;
      const source = fs.readFileSync(file, "utf8");
      // Inside one Button's source, never crossing its close: attribute values
      // hold arrow functions, so `[^>]*` would stop at the `=>`.
      const inside = "(?:(?!<\\/Button>)[\\s\\S])";
      const pattern = new RegExp(
        `<Button\\b${inside}*?variant="contrast"${inside}*<\\/Button>\\s*<Button\\b${inside}*?>\\s*Cancel\\s*<\\/Button>`,
        "g"
      );
      for (const _ of source.matchAll(pattern)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the reduced-motion rule the press hook relies on", () => {
    const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
    expect(css).toMatch(/\.press-scale\s*\{\s*scale:\s*none\s*!important;/);
  });
});
