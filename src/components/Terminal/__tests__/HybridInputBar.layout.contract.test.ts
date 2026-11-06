// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Two layout rules the composer regressed on, pinned as rules rather than as
 * values so a future redesign restates them instead of churning them.
 *
 * 1. **The controls anchor to an edge of the canvas, never its midpoint.** The
 *    shell was `items-center`, so the `❯` and the trailing buttons tracked the
 *    middle of a growing draft — the attach target sat at a different height
 *    for every draft length, and in a bottom-pinned pane it slid upward as the
 *    user typed.
 *
 * 2. **Every control in the composer meets the WCAG 2.5.8 24px floor.** The
 *    stash button was 20px tall, crowded by neighbours close enough that the
 *    spacing exception cannot rescue it.
 *
 * Source enforcement rather than a rendering assertion, matching the
 * drop-target contract below: standing up the whole bar, CodeMirror and its stores
 * to measure two buttons buys very little over reading the classes, and the
 * classes are where both defects actually lived.
 */

const BAR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "HybridInputBar.tsx");

function source(): string {
  return fs.readFileSync(BAR, "utf8");
}

/**
 * The file with comments removed — `//` lines and `{/* … *\/}` JSX blocks.
 *
 * Every rule below is about what the component *declares*, and the comments
 * beside those declarations necessarily name the utility that was replaced
 * ("`items-end` rather than `items-center`", "at `h-5 w-5` this was…"). Reading
 * them makes the contract fail on its own rationale, which is how the first
 * version of this test failed twice. A commented-out `className` would
 * otherwise satisfy a positive match too.
 */
function declarations(): string {
  return source()
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The declared height, in Tailwind steps, of every `<button>` the bar renders.
 *
 * Scoped to the span between each button's `className` and its `aria-label`,
 * which every one of them carries in that order. Two things are deliberately
 * out of that window: the icon glyphs nested inside the button (`h-3.5`, and
 * the `h-4 w-4` submit spinner), and any explanatory comment above the
 * `className` — a comment naming the old size is prose, not a declaration, and
 * reading it would make this test fail on its own documentation.
 *
 * Decimal utilities are excluded too: `h-3.5` must not read as `h-3`.
 */
function buttonHeights(text: string): number[] {
  return text
    .split("<button")
    .slice(1)
    .map((part) => {
      const region = part.slice(0, part.indexOf("aria-label"));
      const declaration = region.slice(region.indexOf("className"));
      const match = /\bh-(\d+)(?![\d.])/.exec(declaration);
      return match ? Number(match[1]) : null;
    })
    .filter((height): height is number => height !== null);
}

describe("HybridInputBar layout contract", () => {
  it("anchors the shell's controls to an edge, never the canvas midpoint", () => {
    const text = declarations();
    const shell = text.slice(text.indexOf("group/shell relative"));
    const classes = shell.slice(0, shell.indexOf("transition-["));

    expect(classes).toMatch(/\bitems-(end|start)\b/);
    expect(classes).not.toMatch(/\bitems-center\b/);
  });

  it("keeps every button target at or above the 24px floor", () => {
    // Tailwind's scale is 4px per step, so the WCAG 2.5.8 24px floor is `h-6`.
    // The composer's controls sit shoulder to shoulder, so the spacing
    // exception cannot rescue an undersized one.
    const FLOOR_STEPS = 6;
    const heights = buttonHeights(declarations());

    // The attach and stash buttons. The mic declares its own size in
    // `VoiceInputButton.tsx`.
    expect(heights.length).toBeGreaterThanOrEqual(2);
    expect(heights.filter((height) => height < FLOOR_STEPS)).toEqual([]);
  });

  it("takes the trailing controls out of the text's flow, so placing them cannot rewrap the draft", () => {
    // The controls sit in the shell's bottom-right corner, beside the draft's
    // last row or on a row beneath it, decided from where that row ends
    // (`useComposerMeasure`). That rule is only free of a feedback loop while
    // the text wraps at the same width in both arrangements: the group is
    // positioned out of flow, and the canvas track carries no utility that
    // answers the rail. The canvas never reorders or takes a row of its own,
    // so the text column does not shift and the `❯` keeps pointing at the
    // line being typed.
    const text = declarations();
    const inner = /<div\s+ref=\{trailingGroupRef\}\s+className="([^"]*)"/.exec(text)?.[1] ?? "";
    const track = /className="[^"]*\bflex-1\b[^"]*"/.exec(text)?.[0] ?? "";

    expect(inner).toMatch(/\babsolute\b/);
    expect(track).not.toMatch(/composer-rail/);
    expect(track).not.toMatch(/\border-/);
    expect(track).not.toMatch(/\bbasis-full\b/);
  });

  it("measures the content-sized trailing group", () => {
    // `useComposerMeasure` reads this group's left edge to decide whether the
    // last row leaves it room, so its box must be the buttons' and nothing
    // else: no basis, no growth, no width utility — any of those would widen
    // it past its buttons and send a draft that fits to the rail.
    const text = declarations();
    const inner = /<div\s+ref=\{trailingGroupRef\}\s+className="([^"]*)"/.exec(text)?.[1] ?? "";

    expect(inner).toMatch(/\bshrink-0\b/);
    expect(inner).not.toMatch(/\bbasis-/);
    expect(inner).not.toMatch(/\b(flex-1|grow|flex-grow)\b/);
    expect(inner).not.toMatch(/\bw-(full|screen|\[|\d)/);
  });

  it("draws the `❯` as a glyph as wide as itself, with nothing a control has", () => {
    // #15309: the marker was a 24px button. It keeps the control height, so it
    // sits centred on the draft's last row, but takes only the glyph's width
    // and has no hover, focus or tooltip of its own.
    const text = declarations();
    const at = text.indexOf("data-composer-marker");
    expect(at, "the marker element").toBeGreaterThan(-1);
    const element = text.slice(text.lastIndexOf("<", at), text.indexOf("</span>", at));
    const classes = element.slice(element.indexOf("className"));

    expect(element).toMatch(/aria-hidden="true"/);
    expect(element).not.toMatch(/\b(onClick|tabIndex|role)=/);
    expect(classes).toMatch(/\bh-6\b/);
    expect(classes).toMatch(/\bshrink-0\b/);
    expect(classes).not.toMatch(/(^|[\s"])(min-)?w-/);
    expect(classes).not.toMatch(/\b(hover|focus-visible|group-hover):/);
    expect(classes).not.toMatch(/COMPOSER_CONTROL_/);
    const tooltips = text.match(/<Tooltip\b[\s\S]*?<\/Tooltip>/g) ?? [];
    expect(tooltips.some((block) => block.includes("data-composer-marker"))).toBe(false);
  });

  it("gives the canvas track a zero min-width so it can actually shrink", () => {
    // Flex items default to `min-width: auto`, which stops the canvas
    // shrinking past its longest unbreakable token. Matched on the track's
    // distinguishing pair rather than its whole class string, so adding an
    // unrelated utility to it does not fail this.
    const track = /className="[^"]*\bflex-1\b[^"]*"/.exec(declarations())?.[0] ?? "";

    expect(track).toMatch(/\bmin-w-0\b/);
  });

  it("holds the canvas track at the control height so one line stays centred", () => {
    // A single-line canvas is 20px beside 24px controls, so bottom anchoring
    // alone drops it 2px. The track carries the control height instead.
    const track = /className="[^"]*\bflex-1\b[^"]*"/.exec(declarations())?.[0] ?? "";

    expect(track).toMatch(/\bmin-h-6\b/);
    expect(track).toMatch(/\bitems-center\b/);
  });
});

/**
 * The composer's control row — attach, stash and mic — is one family, so each
 * rule here is stated over all three rather than per control. They drifted
 * apart one control at a time: stash ignored the composer's `disabled`, attach
 * and mic each dimmed themselves on top of the shell's own dim (to 30% and 24%
 * beside a control at 60%), and tooltips opened toward the pane edge while
 * others opened away from it. The `❯` is not one of them: it is a prompt
 * marker, not a control (#15309).
 *
 * Source enforcement, like the layout contract above: the classes are where
 * every one of these defects lived.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function declarationsOf(file: string): string {
  return fs
    .readFileSync(path.join(DIR, file), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The `<Tooltip>…</Tooltip>` block whose button carries `label`, or the file's only one. */
function tooltipBlock(src: string, label?: string): string {
  const blocks = src.match(/<Tooltip>[\s\S]*?<\/Tooltip>/g) ?? [];
  const found = label ? blocks.filter((b) => b.includes(`aria-label="${label}"`)) : blocks;
  expect(found, `one tooltip block for ${label ?? "the mic"}`).toHaveLength(1);
  return found[0]!;
}

/**
 * The button's own props, from `<button` to its `aria-label` — the glyph inside
 * is out of the window, so the mic's paused bars (`opacity-70` marks, not a
 * dim) are not read as the button's.
 */
function button(block: string): string {
  const match = block.match(/<button[\s\S]*?aria-label=/);
  expect(match).not.toBeNull();
  return match![0];
}

function side(block: string): string | undefined {
  return block.match(/<TooltipContent[^>]*\bside="([a-z]+)"/)?.[1];
}

const bar = declarationsOf("HybridInputBar.tsx");
const voice = declarationsOf("VoiceInputButton.tsx");

const CONTROLS = [
  ["attach", tooltipBlock(bar, "Attach files")],
  ["stash", tooltipBlock(bar, "Restore stashed input")],
  ["mic", tooltipBlock(voice)],
] as const;

describe("composer control row", () => {
  it.each(CONTROLS)("%s takes the shared text, hover and focus recipe", (_name, block) => {
    const b = button(block);
    for (const recipe of [
      "COMPOSER_CONTROL_TEXT_CLASS",
      "COMPOSER_CONTROL_HOVER_BG_CLASS",
      "COMPOSER_CONTROL_FOCUS_CLASS",
    ]) {
      expect(b).toContain(recipe);
    }
  });

  it.each(CONTROLS)("%s follows the composer's disabled state", (_name, block) => {
    // Bound to the prop, not merely present: `disabled={false}` would pass a
    // presence check and leave the control live in an unavailable composer.
    expect(button(block)).toMatch(/\bdisabled=\{[^}]*\bdisabled\b/);
  });

  it("gives every control one shape, so the hover wash and focus outline match", () => {
    const radii = CONTROLS.map(([name, block]) => {
      const found = button(block).match(/\brounded-[\w[\]()-]+/g) ?? [];
      expect(found, `${name} declares exactly one radius`).toHaveLength(1);
      return found[0];
    });
    expect(new Set(radii).size).toBe(1);
  });

  it.each(CONTROLS)("%s adds no dim of its own, so the shell's is the only one", (_name, block) => {
    expect(button(block)).not.toMatch(/opacity-/);
  });

  it("dims an unavailable composer by its inks, never by opacity", () => {
    // An opacity dim on the shell also halved the line that says why the
    // composer is unavailable. The marker and the controls step down to one
    // shared inactive ink instead, so they still read as one family.
    const dims = bar.match(/disabled && "[^"]*opacity-[^"]*"/g) ?? [];
    expect(dims).toEqual([]);
    expect(bar).toMatch(/"--ib-control-mix": disabled \? DISABLED_CONTROL_MIX/);
    expect(bar).toMatch(/"--ib-marker": disabled\s*\?\s*DISABLED_CONTROL_INK/);
  });

  it("opens every tooltip on one side, away from the pane edge", () => {
    const sides = new Set(CONTROLS.map(([, block]) => side(block)));
    expect(sides.size).toBe(1);
    expect([...sides][0]).toBe("top");
  });
});

describe("HybridInputBar shortcut tooltips — issue #6434", () => {
  it("does not hardcode Unicode shortcut glyphs", () => {
    expect(source()).not.toMatch(/⌘/);
    expect(source()).not.toMatch(/⌃/);
    expect(source()).not.toMatch(/⇧/);
  });
});

// The hybrid input's editor lives in one of two hosts: the compact bar, or the
// Expanded Editor dialog it is reparented into. A file drop only turns into an
// `@file` token because a React drop target wraps whichever host is showing —
// CodeMirror's own file handling is deliberately suppressed
// (`useEditorDomHandlers`, #11710) on the assumption that one does. The dialog
// shipped without one, so a drop there was claimed by that suppression and
// inserted nothing at all (#12570).
//
// What a drop inserts is covered by `useDragDrop.test.ts`, which drives the
// hook's handlers directly. What that suite cannot see is whether those
// handlers reach both hosts, and that is the half that drifted. Source
// enforcement rather than a rendering assertion is a cost call: standing up
// the whole bar, its stores and the dialog to dispatch one drop buys a single
// assertion.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BAR_PATH = path.resolve(TEST_DIR, "../HybridInputBar.tsx");

/** Each drag prop a drop target needs, and the `useDragDrop` handler it must bind. */
const DROP_HANDLERS = {
  onDragEnter: "handleDragEnter",
  onDragOver: "handleDragOver",
  onDragLeave: "handleDragLeave",
  onDrop: "handleDrop",
} as const;

const OVERLAY_TAG = "FileDropOverlay";
const DIALOG_TAG = "AppDialog";

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function parseBar(): ts.SourceFile {
  return ts.createSourceFile(
    BAR_PATH,
    fs.readFileSync(BAR_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function openingOf(node: JsxNode): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function tagOf(node: JsxNode, source: ts.SourceFile): string {
  return openingOf(node).tagName.getText(source);
}

function jsxNodes(root: ts.Node): JsxNode[] {
  const found: JsxNode[] = [];
  walk(root, (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) found.push(node);
  });
  return found;
}

function attributeOf(node: JsxNode, name: string): ts.JsxAttribute | undefined {
  return openingOf(node).attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name
  );
}

function expressionOf(attribute: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const initializer = attribute?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) return undefined;
  return initializer.expression;
}

/**
 * Whether the element's `ref` is `refName` itself, or a callback that stores
 * its node in `refName.current` — the two shapes the hosts use. Only the node
 * counts: a callback that merely clears some other ref is not bound to it.
 */
function refBinds(node: JsxNode, refName: string): boolean {
  const expression = expressionOf(attributeOf(node, "ref"));
  if (!expression) return false;
  if (ts.isIdentifier(expression)) return expression.text === refName;
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const param = expression.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return false;
  let assigns = false;
  walk(expression.body, (inner) => {
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(inner.left) &&
      inner.left.name.text === "current" &&
      ts.isIdentifier(inner.left.expression) &&
      inner.left.expression.text === refName &&
      ts.isIdentifier(inner.right) &&
      inner.right.text === param.text
    ) {
      assigns = true;
    }
  });
  return assigns;
}

function elementWithRef(source: ts.SourceFile, refName: string): JsxNode {
  const matches = jsxNodes(source).filter((node) => refBinds(node, refName));
  // Guards the guard: a renamed ref would otherwise leave nothing to check.
  expect(matches, `elements bound to ${refName}`).toHaveLength(1);
  const [match] = matches;
  if (!match) throw new Error(`no element bound to ${refName}`);
  return match;
}

function isDropTarget(node: JsxNode): boolean {
  return Object.keys(DROP_HANDLERS).some((prop) => attributeOf(node, prop) !== undefined);
}

/**
 * The first element from the host outwards that handles any drag event. It
 * starts at the host itself, so a handler there or on anything between it and
 * the intended target is what gets checked — and fails as incomplete — rather
 * than being skipped while it intercepts the drop.
 */
function nearestDropTargetAround(node: JsxNode): JsxNode | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) &&
      isDropTarget(current)
    ) {
      return current;
    }
  }
  return undefined;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Drag props not bound by name to the matching hook handler. Spreads are
 * rejected outright: their contents are invisible here, so one could override
 * a handler, or stand in for a dropped one, and keep this suite green.
 */
function unboundHandlers(node: JsxNode): string[] {
  if (openingOf(node).attributes.properties.some(ts.isJsxSpreadAttribute)) return ["{...spread}"];
  return Object.entries(DROP_HANDLERS)
    .filter(([prop, handler]) => {
      const expression = expressionOf(attributeOf(node, prop));
      return !expression || !ts.isIdentifier(expression) || expression.text !== handler;
    })
    .map(([prop]) => prop);
}

function overlaysWithin(node: JsxNode, source: ts.SourceFile): JsxNode[] {
  return jsxNodes(node).filter((inner) => tagOf(inner, source) === OVERLAY_TAG);
}

describe("HybridInputBar drop targets (#12570)", () => {
  it("takes every drop handler from a single useDragDrop call", () => {
    const source = parseBar();
    const calls: ts.CallExpression[] = [];
    walk(source, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useDragDrop"
      ) {
        calls.push(node);
      }
    });

    // Two instances would each keep their own drag depth and hover state, and
    // the hosts would disagree about whether a drag is in progress.
    expect(calls).toHaveLength(1);
    const declaration = calls[0]?.parent;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isObjectBindingPattern(declaration.name)
    ) {
      throw new Error("useDragDrop's result is not destructured into its handlers");
    }
    const bound = declaration.name.elements.flatMap((element) =>
      !element.propertyName && ts.isIdentifier(element.name) ? [element.name.text] : []
    );
    expect(bound).toEqual(expect.arrayContaining(Object.values(DROP_HANDLERS)));
  });

  // An agent-context drop drafts into a named pane; without the id the hook has
  // no draft to write and refuses every such drag, silently, in both hosts.
  it("tells useDragDrop whose draft an agent-context drop lands in", () => {
    const source = parseBar();
    let args: string[] = [];
    walk(source, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useDragDrop"
      ) {
        args = node.arguments.map((arg) => arg.getText(source));
      }
    });
    expect(args[3]).toBe("terminalId");
  });

  it("wraps the compact editor host in a complete drop target", () => {
    const source = parseBar();
    const target = elementWithRef(source, "inputShellRef");

    expect(nearestDropTargetAround(elementWithRef(source, "compactEditorHostRef"))).toBe(target);
    expect(unboundHandlers(target)).toEqual([]);
    expect(overlaysWithin(target, source)).toHaveLength(1);
  });

  it("wraps the Expanded Editor host in a complete drop target inside the dialog", () => {
    const source = parseBar();
    const host = elementWithRef(source, "modalEditorHostRef");
    const target = nearestDropTargetAround(host);

    expect(target, "a drop target around the modal editor host").toBeDefined();
    if (!target) return;
    expect(unboundHandlers(target)).toEqual([]);

    const dialogs = jsxNodes(source).filter((node) => tagOf(node, source) === DIALOG_TAG);
    expect(dialogs.some((dialog) => isWithin(target, dialog))).toBe(true);

    // The host is the dialog's scroll container. An overlay inside it would
    // scroll away with a long draft instead of covering the visible editor.
    const overlays = overlaysWithin(target, source);
    expect(overlays).toHaveLength(1);
    expect(overlays.filter((overlay) => isWithin(overlay, host))).toEqual([]);
  });
});
