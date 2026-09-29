import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DROP_INDICATOR_INK, DROP_TARGET_FRAME } from "@/components/DragDrop/dropIndicator";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const ROOTS = ["src", "plugins"].map((dir) => path.join(REPO_ROOT, dir));

function collect(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "__preview__", "node_modules", "dist"].includes(entry.name)) continue;
      out.push(...collect(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Import declarations stripped, so a rule about using a token is not satisfied
// by a file that imports it and paints something else.
const IMPORTS = /^import\s[^;]*?from\s*["'][^"']+["'];?$/gm;

const SOURCES = ROOTS.flatMap(collect).map((file) => {
  const text = fs.readFileSync(file, "utf8");
  return { rel: path.relative(REPO_ROOT, file), text, code: text.replace(IMPORTS, "") };
});

const SIDEBAR_CSS = fs.readFileSync(
  path.join(REPO_ROOT, "src/styles/components/sidebar.css"),
  "utf8"
);

// The worktree card is the one droppable whose frame cannot be a utility: the
// unlayered sidebar.css base rules beat layered utilities on that element, so
// it sets data-drop-target and sidebar.css draws the frame (checked below).
const CSS_FRAMED_DROPPABLES = new Set(["src/components/Worktree/WorktreeCard.tsx"]);

// Droppables registered in a hook and painted by the component that renders it.
const DROPPABLE_PAINTERS: Record<string, string> = {
  "src/components/Terminal/useContentGridContext.tsx":
    "src/components/Terminal/ContentGridDefault.tsx",
};

const codeOf = (rel: string) => SOURCES.find((s) => s.rel === rel)?.code ?? "";

describe("drag and drop feedback contract", () => {
  it("frames every droppable container with DROP_TARGET_FRAME", () => {
    const droppables = SOURCES.filter(({ text }) => /\buseDroppable\(/.test(text));
    expect(droppables.length).toBeGreaterThan(0);
    const offenders = droppables
      .filter(({ rel }) => !CSS_FRAMED_DROPPABLES.has(rel))
      .filter(
        ({ rel, code }) =>
          !/\bDROP_TARGET_FRAME\b/.test(
            DROPPABLE_PAINTERS[rel] ? codeOf(DROPPABLE_PAINTERS[rel]) : code
          )
      )
      .map(({ rel }) => rel);
    expect(
      offenders,
      "A droppable container draws its armed state with DROP_TARGET_FRAME from src/components/DragDrop/dropIndicator.ts — never its own ring, fill or accent."
    ).toEqual([]);
    for (const rel of CSS_FRAMED_DROPPABLES) {
      const source = SOURCES.find((s) => s.rel === rel);
      expect(source?.text, `${rel} no longer marks data-drop-target`).toMatch(/data-drop-target=/);
    }
  });

  it("spells the same frame in sidebar.css for the worktree card", () => {
    const rule = SIDEBAR_CSS.match(
      /(?:^|\n)\.sidebar-worktree-card\[data-drop-target="true"\]\s*\{([^}]*)\}/
    )?.[1];
    expect(rule, "no drop-target rule in sidebar.css").toBeDefined();

    const [inkToken, alpha] = DROP_INDICATOR_INK.split("/");
    const width = DROP_TARGET_FRAME.match(/(?:^|\s)outline-(\d+)(?:\s|$)/)?.[1];
    const fill = DROP_TARGET_FRAME.match(/(?:^|\s)bg-([\w-]+)(?:\s|$)/)?.[1];
    expect(width).toBeDefined();
    expect(fill).toBeDefined();

    expect(rule).toContain(
      `--card-edge: inset 0 0 0 ${width}px color-mix(in oklab, var(--color-${inkToken}) ${alpha}%, transparent)`
    );
    expect(rule).toMatch(new RegExp(`background:\\s*var\\(--color-${fill}\\)`));

    // Its forced-colours form is the frame's: box-shadow is stripped there.
    const forced = SIDEBAR_CSS.match(
      /@media \(forced-colors: active\)[^]*?\.sidebar-worktree-card\[data-drop-target="true"\]\s*\{([^}]*)\}/
    )?.[1];
    expect(forced).toBeDefined();
    expect(DROP_TARGET_FRAME).toContain("forced-colors:outline-dashed");
    expect(DROP_TARGET_FRAME).toContain("forced-colors:outline-[CanvasText]");
    expect(forced).toMatch(new RegExp(`outline:\\s*${width}px dashed CanvasText`));
    const forcedOffset = DROP_TARGET_FRAME.match(/forced-colors:-outline-offset-(\d+)/)?.[1];
    expect(forcedOffset).toBeDefined();
    expect(forced).toMatch(new RegExp(`outline-offset:\\s*-${forcedOffset}px`));
  });

  it("never gives an armed target the copy cursor", () => {
    // Every drop in the app moves or trashes what it receives; none duplicates
    // it. (Copy-to-clipboard text elsewhere may still wear cursor-copy.)
    const painters = SOURCES.filter(({ text }) => /\buseDroppable\(/.test(text)).map(
      ({ rel }) => DROPPABLE_PAINTERS[rel] ?? rel
    );
    const offenders = painters.filter((rel) => /\bcursor-copy\b/.test(codeOf(rel)));
    expect(offenders).toEqual([]);
  });

  it("takes every activation threshold from dragActivation.ts", () => {
    const offenders = SOURCES.filter(
      ({ rel }) => rel !== "src/components/DragDrop/dragActivation.ts"
    )
      .filter(({ text }) => /\bactivationConstraint\s*:/.test(text))
      .map(({ rel }) => rel);
    expect(
      offenders,
      "Use POINTER_SENSOR_OPTIONS / TOUCH_SENSOR_OPTIONS so a click turns into a drag at one travel everywhere."
    ).toEqual([]);
  });

  it("dims every sortable item in hand to DRAG_GHOST_OPACITY", () => {
    const sortables = SOURCES.filter(({ text }) =>
      /\{[^}]*\bisDragging\b[^}]*\}\s*=\s*useSortable\(/.test(text)
    );
    expect(sortables.length).toBeGreaterThan(0);
    const offenders = sortables
      .filter(({ code }) => !/\bDRAG_GHOST_OPACITY\b/.test(code))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
    // A lifted-card treatment (an opacity class, a floating shadow) on the item
    // in hand is the retired portal recipe.
    const lifted = sortables
      .filter(({ text }) => /isDragging\s*&&\s*["'`][^"'`]*\b(opacity-\d+|shadow-)/.test(text))
      .map(({ rel }) => rel);
    expect(lifted).toEqual([]);
  });

  it("builds every drag grip from DRAG_GRIP_CLASS", () => {
    // Not drag grips in the sense this rule covers: the worktree card's gutter
    // grip spans the card's full height (a different control), and the image
    // diff's divider handle is a comparison slider.
    const exempt = new Set([
      "src/components/Worktree/WorktreeCard.tsx",
      "src/components/FileViewer/ImageDiffViewer.tsx",
      "src/components/ui/dragGripStyles.ts",
    ]);
    const grips = SOURCES.filter(
      ({ rel, text }) => !exempt.has(rel) && /<GripVertical\b/.test(text)
    );
    expect(grips.length).toBeGreaterThan(0);
    // One grip box per glyph, and every glyph at the grip's size.
    const count = (source: string, re: RegExp) => source.match(re)?.length ?? 0;
    const offenders = grips
      .filter(
        ({ code }) =>
          count(code, /<GripVertical\b/g) !==
            count(code, /<GripVertical\b[^>]*DRAG_GRIP_ICON_CLASS/g) ||
          count(code, /\bDRAG_GRIP_CLASS\b/g) < count(code, /<GripVertical\b/g)
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
