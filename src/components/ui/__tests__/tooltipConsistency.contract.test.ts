import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Every icon and action button explains itself through the shared `Tooltip`,
// and every plain tooltip looks the same: the offset, width, padding, type and
// colour `TooltipContent` already sets. Drift here is invisible in review — a
// 6px offset beside a 4px one, a bold label beside a regular one, an OS tooltip
// on one button and a styled one on its neighbour — so the rules are pinned
// rather than the values.
//
// KNOWN LIMITS (a regression guard, not a sound checker):
//   - Only class strings written as literals inside `className` are read.
//   - Native `title` is only policed on the files listed in
//     `TOOLTIP_ONLY_FILES`. Menu-row affordances (AgentButton, PluginTrayButton,
//     DockLaunchButton) and the fleet chip's rows keep theirs on purpose.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];

/**
 * Classes that restyle a plain tooltip away from the standard. Rich hover cards
 * pad themselves (`p-3`) and are not affected by any of these.
 */
const FORBIDDEN_CONTENT_CLASS =
  /(^|\s)(max-w-(?!xs(\s|$))\S+|w-\[\S+|font-(medium|semibold|bold)|text-text-(secondary|muted)|text-(center|right))(?=\s|$)/;

/** Components whose named prop lands on the TooltipContent they render. */
const FORWARDED_CONTENT_CLASS: Record<string, string> = {
  TruncatedTooltip: "contentClassName",
  DismissButton: "tooltipClassName",
};

/** Files whose buttons explain themselves only through `Tooltip`. */
const TOOLTIP_ONLY_FILES = [
  "src/components/HelpPanel/HelpSessionTabs.tsx",
  "src/components/Terminal/VoiceInputButton.tsx",
  "src/components/Portal/DevServerDashboard.tsx",
  "src/components/Settings/EnvVarEditor.tsx",
  "src/components/Settings/AgentScopeEditor/CustomPresetChrome.tsx",
  "src/components/Settings/AgentScopeEditor/FallbackChainEditor.tsx",
  "src/components/Worktree/DiffNoteWidgets.tsx",
  "src/components/Terminal/BannerOverflowMenu.tsx",
  "src/components/Project/RunningTaskList.tsx",
  "src/components/Fleet/SavedFleetQuickRecall.tsx",
  "src/components/Settings/PresetColorPicker.tsx",
  "src/components/Project/GeneralTab.tsx",
  "src/components/Plugin/PluginManagerView.tsx",
  "src/components/Plugin/ProjectPluginSection.tsx",
  "src/components/Terminal/UpdateCwdDialog.tsx",
  "plugins/builtin/github/renderer/components/GitHubResourceList.tsx",
];

const TOOLTIP_TRIGGER_TAGS = new Set(["TooltipTrigger", "TruncatedTooltip"]);

function tsxFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "__tests__", "__preview__"].includes(entry.name)) continue;
      tsxFiles(full, found);
    } else if (entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function isOpening(node: ts.Node): node is Opening {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return undefined;
}

function stringsIn(node: ts.Node): string[] {
  const found: string[] = [];
  walk(node, (child) => {
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
      found.push(child.text);
    }
  });
  return found;
}

function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${path.relative(REPO_ROOT, source.fileName)}:${line + 1}`;
}

const sources = SCAN_ROOTS.flatMap((root) => tsxFiles(root)).map(parse);

describe("tooltip consistency", () => {
  it("never restyles a plain TooltipContent's offset, width, weight or text colour", () => {
    const violations: string[] = [];
    let inspected = 0;
    for (const source of sources) {
      walk(source, (node) => {
        if (!isOpening(node)) return;
        const tag = node.tagName.getText();
        // Wrappers that forward a class straight onto their TooltipContent.
        const forwarded = FORWARDED_CONTENT_CLASS[tag];
        if (tag !== "TooltipContent" && !forwarded) return;
        if (tag === "TooltipContent") {
          inspected++;
          if (attribute(node, "sideOffset")) violations.push(`${where(source, node)} sideOffset`);
        }
        const className = attribute(node, forwarded ?? "className");
        if (!className?.initializer) return;
        for (const text of stringsIn(className.initializer)) {
          const match = FORBIDDEN_CONTENT_CLASS.exec(text);
          if (match) violations.push(`${where(source, node)} ${match[2]}`);
        }
      });
    }
    // Coverage floor: a rename that stops the tag matching would otherwise
    // pass this file silently.
    expect(inspected).toBeGreaterThan(200);
    expect(violations).toEqual([]);
  });

  it("gives buttons in tooltip-only files no native title", () => {
    const violations: string[] = [];
    for (const relative of TOOLTIP_ONLY_FILES) {
      const source = parse(path.join(REPO_ROOT, relative));
      walk(source, (node) => {
        if (!isOpening(node)) return;
        const tag = node.tagName.getText();
        if (tag !== "button" && tag !== "Button") return;
        if (attribute(node, "title")) violations.push(where(source, node));
      });
    }
    expect(violations).toEqual([]);
  });

  it("never puts a native title on an element that wraps a styled tooltip", () => {
    const violations: string[] = [];
    for (const source of sources) {
      walk(source, (node) => {
        if (!ts.isJsxElement(node)) return;
        if (!attribute(node.openingElement, "title")) return;
        const tag = node.openingElement.tagName.getText();
        // A lowercase tag is a DOM element, whose title every descendant inherits.
        if (tag[0] !== tag[0]!.toLowerCase()) return;
        let wraps = false;
        node.children.forEach((child) =>
          walk(child, (inner) => {
            if (isOpening(inner) && TOOLTIP_TRIGGER_TAGS.has(inner.tagName.getText())) {
              wraps = true;
            }
          })
        );
        if (wraps) violations.push(where(source, node));
      });
    }
    expect(violations).toEqual([]);
  });
});
