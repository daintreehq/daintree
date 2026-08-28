#!/usr/bin/env tsx
// Inventories, classifies and rewrites the `text-daintree-text/NN` opacity ramp
// (#12065). Companion to `theme-text-contrast.ts`: that script measures what the
// ramp renders at, this one decides what each site becomes and proves nothing
// was missed.
//
// The ramp expressed a text hierarchy through alpha rather than tokens. Four
// solid roles cannot carry fifteen steps, and the measured bands collapse most
// of it onto one role — so the interesting output is not the rewrite but the
// accounting: every occurrence lands in a named band or a named carve-out, and
// the totals reconcile against a lexical scan that knows nothing about the AST.
//
//   npm run theme:text-ramp             report the current split
//   npm run theme:text-ramp -- --plan   write the manifest
//   npm run theme:text-ramp -- --pairs  every state pair, before and after
//   npm run theme:text-ramp -- --apply  rewrite sources from the manifest
//   npm run theme:text-ramp -- --check  fail if the tree and manifest disagree
//
// Report-only and deliberately outside `npm run check`. The permanent guards are
// the two ESLint rules (`no-text-color-slash-alpha`, `no-legacy-daintree-utilities`)
// with their ratchet baselines, plus the manifest-membership contract test in
// `src/config/__tests__/colorSystem.contract.test.ts`.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { JsxOpeningElement, JsxSelfClosingElement, SourceFile } from "ts-morph";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "baselines", "text-ramp-manifest.json");

/** Roots the ESLint contract rules already police, so the two inventories agree. */
const ROOTS = ["src", "shared", "electron", "plugins", "packages"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "dist-electron", "build", "release"]);

/** Same shape `lint-ratchet.mjs` uses, so "not product code" means one thing here. */
const TEST_FILE = /[/\\](?:__tests__|e2e)[/\\]|\.(?:test|spec)\.[^.]+$/;

const RAMP_TOKEN = /(?<![\w-])((?:[\w@&[\]./-]+:)*)text-daintree-text\/(\d+)(?![\w/-])/g;

/**
 * The measured bands from #12065, applied with floor non-regression: a step may
 * only adopt a role whose weakest measurement across all 15 themes and 5 display
 * surfaces is no worse than the step's own. `text-muted` receives nothing — its
 * floor is Lc 16.0 / 2.2:1 on namib's elevated panel, below the `/50` step it
 * looks like it should absorb, and `getThemeContrastWarnings()` guards it on
 * light themes only.
 *
 * `/40` is absent on purpose: #12003 already ruled site by site on that step.
 */
const BANDS: { steps: number[]; role: TextRole }[] = [
  { steps: [20, 25, 30, 35], role: "placeholder" },
  { steps: [45, 50, 55, 60, 65, 70], role: "secondary" },
  { steps: [75, 80, 85, 90], role: "primary" },
];

export type TextRole = "placeholder" | "secondary" | "primary";

/** Ascending contrast. Promotion walks up this list; `primary` is the ceiling. */
export const ROLE_ORDER: TextRole[] = ["placeholder", "secondary", "primary"];

/**
 * Every text role by measured floor, `text-muted` included. Muted is never a
 * migration target — its floor is 2.2:1 on namib's elevated panel, below the
 * `/50` step — but a control may already carry a `hover:text-text-muted`, and
 * ranking a pair means being able to place it.
 */
const ROLE_RANK: Record<string, number> = {
  placeholder: 0,
  muted: 1,
  secondary: 2,
  primary: 3,
};

const SEMANTIC_TOKEN =
  /(?<![\w-])((?:[\w@&[\]./-]+:)*)text-text-(primary|secondary|muted|placeholder)(?![\w/-])/g;

export type KeepCategory =
  | "icon-affordance"
  | "decorative-glyph"
  | "disabled-state"
  | "placeholder-variant"
  | "opacity-composite"
  | "prior-ruling-40"
  | "semantic-state-pair"
  | "test-assertion"
  | "comment-reference"
  | "unaccounted";

export type MigrateCategory = "band" | "pair-promoted" | "pair-reopened-40";

export type Occurrence = {
  file: string;
  line: number;
  /** Byte offset in the file, so `--apply` never has to re-find the token. */
  start: number;
  end: number;
  token: string;
  variants: string;
  step: number;
  /** Stable key for every ramp token that paints the same element. */
  group: string;
  /** Ternary-branch path, outer to inner. Two tokens coexist iff one path prefixes the other. */
  branch: string;
  decision: "migrate" | "keep";
  category: KeepCategory | MigrateCategory;
  /** Present when `decision` is `migrate`. */
  target?: string;
  /** Why the classifier ruled this way, in the classifier's own vocabulary. */
  evidence: string;
};

export type Manifest = {
  generated: string;
  total: number;
  files: number;
  occurrences: Occurrence[];
};

export function bandFor(step: number): TextRole | null {
  for (const band of BANDS) if (band.steps.includes(step)) return band.role;
  return null;
}

export function roleClass(role: TextRole): string {
  return `text-text-${role}`;
}

/** One role brighter, saturating at `primary`. Never lowers a contrast floor. */
export function promote(role: TextRole): TextRole {
  const index = ROLE_ORDER.indexOf(role);
  return ROLE_ORDER[Math.min(index + 1, ROLE_ORDER.length - 1)]!;
}

export function replacementToken(variants: string, role: TextRole): string {
  return `${variants}${roleClass(role)}`;
}

/**
 * Variants that name a *state* rather than a breakpoint or a container query.
 * A state token is the other half of a pair — it has to move with the resting
 * colour or the affordance inverts.
 */
const STATE_VARIANT =
  /^(?:group-)?(?:hover|focus|focus-visible|focus-within|active|aria-selected|aria-expanded|aria-checked|data-\[state=|data-\[selected|checked|open|current)/;
const DISABLED_VARIANT = /^(?:group-|peer-)?(?:aria-)?disabled/;

export function variantSegments(variants: string): string[] {
  return variants.split(":").filter(Boolean);
}

export function isStateVariant(variants: string): boolean {
  return variantSegments(variants).some((segment) => STATE_VARIANT.test(segment));
}

export function isDisabledVariant(variants: string): boolean {
  return variantSegments(variants).some((segment) => DISABLED_VARIANT.test(segment));
}

export function isPlaceholderVariant(variants: string): boolean {
  return variantSegments(variants).some((segment) => segment === "placeholder");
}

function collectSourceFiles(root: string, out: string[]): void {
  const absolute = path.join(REPO_ROOT, root);
  if (!fs.existsSync(absolute)) return;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(full);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
    }
  };
  walk(absolute);
}

/**
 * Byte ranges of every comment in a parsed file. TypeScript's raw scanner is not
 * usable here — run linearly over TSX it desyncs on JSX text and misses comments
 * inside markup — so the ranges come off the parse tree, where every comment is
 * leading or trailing trivia of some token.
 */
function commentRanges(sourceFile: SourceFile): [number, number][] {
  const ranges: [number, number][] = [];
  for (const node of sourceFile.getDescendants()) {
    for (const comment of [...node.getLeadingCommentRanges(), ...node.getTrailingCommentRanges()]) {
      ranges.push([comment.getPos(), comment.getEnd()]);
    }
  }
  return ranges;
}

export type LexicalHit = {
  file: string;
  line: number;
  start: number;
  end: number;
  token: string;
};

/**
 * Every ramp occurrence found by reading bytes, with no parser involved at all.
 * The AST pass is what classifies, but this is what proves it saw everything — a shape the AST walker cannot reach (an imperative
 * `el.className =`, say) surfaces as a reconciliation failure rather than as a
 * silently missing site.
 */
export function lexicalScan(): LexicalHit[] {
  const files: string[] = [];
  for (const root of ROOTS) collectSourceFiles(root, files);

  const hits: LexicalHit[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("text-daintree-text/")) continue;
    const relative = path.relative(REPO_ROOT, file);
    RAMP_TOKEN.lastIndex = 0;
    for (const match of source.matchAll(RAMP_TOKEN)) {
      const start = match.index;
      hits.push({
        file: relative,
        line: source.slice(0, start).split("\n").length,
        start,
        end: start + match[0].length,
        token: match[0],
      });
    }
  }
  return hits;
}

type ElementInfo = {
  tag: string;
  ariaHidden: boolean;
  selfClosing: boolean;
  hasTextChild: boolean;
  singleGlyphChild: boolean;
  /** Every child is an icon and none is text — the control's colour is an affordance. */
  iconOnly: boolean;
};

const ICON_MODULES = /^(?:lucide-react|@\/components\/icons|\.\.?\/.*icons?)$/;
const ICON_TAG = /(?:Icon|Glyph|Chevron|Spinner|Caret|Arrow)$/;
const KNOWN_ICON_TAGS = new Set(["svg", "path", "Spinner", "Icon", "DaintreeIcon"]);

function importedIconNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!ICON_MODULES.test(specifier) && !/icons?$/i.test(specifier)) continue;
    for (const named of declaration.getNamedImports()) names.add(named.getName());
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) names.add(defaultImport.getText());
  }
  return names;
}

function isIconTag(tag: string, icons: Set<string>): boolean {
  return icons.has(tag) || KNOWN_ICON_TAGS.has(tag) || ICON_TAG.test(tag);
}

/**
 * Whether a JSX child renders icons and nothing else. Conditional children are
 * followed into their branches — `{copied ? <Check /> : <Copy />}` is as
 * icon-only as a bare `<Copy />`, and only the branches render, never the test.
 */
function rendersOnlyIcons(node: Node | undefined, icons: Set<string>): boolean {
  if (!node) return true;
  if (Node.isJsxText(node)) return node.getText().trim() === "";
  if (Node.isJsxSelfClosingElement(node)) return isIconTag(node.getTagNameNode().getText(), icons);
  if (Node.isJsxElement(node)) {
    return (
      isIconTag(node.getOpeningElement().getTagNameNode().getText(), icons) ||
      node.getJsxChildren().every((child) => rendersOnlyIcons(child, icons))
    );
  }
  if (Node.isJsxFragment(node)) {
    return node.getJsxChildren().every((child) => rendersOnlyIcons(child, icons));
  }
  if (Node.isJsxExpression(node)) return rendersOnlyIcons(node.getExpression(), icons);
  if (Node.isParenthesizedExpression(node)) return rendersOnlyIcons(node.getExpression(), icons);
  if (Node.isConditionalExpression(node)) {
    return (
      rendersOnlyIcons(node.getWhenTrue(), icons) && rendersOnlyIcons(node.getWhenFalse(), icons)
    );
  }
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getText() === "&&") {
    return rendersOnlyIcons(node.getRight(), icons);
  }
  if (Node.isNullLiteral(node)) return true;
  if (Node.isIdentifier(node) && node.getText() === "undefined") return true;
  return false;
}

function describeElement(
  element: JsxOpeningElement | JsxSelfClosingElement,
  icons: Set<string>
): ElementInfo {
  const tag = element.getTagNameNode().getText();
  const ariaHidden = element
    .getAttributes()
    .some(
      (attribute) =>
        Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === "aria-hidden"
    );
  const selfClosing = Node.isJsxSelfClosingElement(element);

  let hasTextChild = false;
  let singleGlyphChild = false;
  let iconOnly = false;
  const parent = element.getParent();
  if (!selfClosing && Node.isJsxElement(parent)) {
    const children = parent.getJsxChildren();
    const texts = children
      .filter(Node.isJsxText)
      .map((child) => child.getText().trim())
      .filter(Boolean);
    const dynamic = children.some((child) => Node.isJsxExpression(child));
    const elements = children.filter(
      (child) => Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)
    );
    hasTextChild = texts.length > 0 || dynamic || elements.length > 0;
    const joined = texts.join("");
    singleGlyphChild =
      !dynamic &&
      elements.length === 0 &&
      texts.length > 0 &&
      [...joined].length === 1 &&
      !/\w/u.test(joined);

    // An icon-only control: `<button className="text-…">` wrapping nothing but a
    // glyph. The class paints the icon through `currentColor`, so this is the
    // issue's "icon-only controls, where the colour is an affordance" carve-out
    // even though the class does not sit on the icon itself.
    iconOnly =
      texts.length === 0 &&
      (elements.length > 0 || dynamic) &&
      children.every((child) => rendersOnlyIcons(child, icons));
  }

  return { tag, ariaHidden, selfClosing, hasTextChild, singleGlyphChild, iconOnly };
}

/**
 * An unconditional `opacity-N` (N below 100) on the element or a JSX ancestor:
 * the alpha the author wrote is not the alpha that paints, so the site has to be
 * judged on the composite rather than on its nominal step (#9691).
 *
 * Variant-prefixed opacity is deliberately not a composite. `hover:opacity-100`
 * and `group-hover:opacity-100` are reveals whose resting state is the hidden
 * one, and `disabled:opacity-50` only dims in a state the disabled carve-out
 * already owns — in both the resting composite is 1. `opacity-0` is the same
 * reveal idiom written from the other end.
 */
export function isCompositingOpacity(token: string): boolean {
  const match = /^opacity-(\d+)$/.exec(token);
  if (!match) return false;
  const value = Number(match[1]);
  return value > 0 && value < 100;
}

/**
 * Whether a class expression applies `opacity-N` unconditionally. A conditional
 * one (`isUnavailable && "opacity-50"`, or a ternary branch) dims only in a state
 * the site's own classes do not describe, so the resting composite is still 1 and
 * treating it as a composite would carve out ordinary prose.
 */
function hasUnconditionalOpacity(root: Node): boolean {
  const literals = [
    ...root.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...root.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const literal of literals) {
    let conditional = false;
    let current: Node | undefined = literal;
    while (current && current !== root) {
      const parent: Node | undefined = current.getParent();
      if (
        parent &&
        (Node.isConditionalExpression(parent) ||
          (Node.isBinaryExpression(parent) &&
            ["&&", "||", "??"].includes(parent.getOperatorToken().getText())))
      ) {
        conditional = true;
        break;
      }
      current = parent;
    }
    if (conditional) continue;
    const tokens = literal.getLiteralText().split(/\s+/).filter(Boolean);
    if (tokens.some(isCompositingOpacity)) return true;
  }
  return false;
}

function hasOpacityAncestor(node: Node): boolean {
  let current: Node | undefined = node.getParent();
  let hops = 0;
  while (current && hops < 40) {
    if (Node.isJsxElement(current) || Node.isJsxSelfClosingElement(current)) {
      const opening = Node.isJsxElement(current) ? current.getOpeningElement() : current;
      for (const attribute of opening.getAttributes()) {
        if (!Node.isJsxAttribute(attribute)) continue;
        if (!/^class(?:Name)?$/.test(attribute.getNameNode().getText())) continue;
        if (hasUnconditionalOpacity(attribute)) return true;
      }
    }
    current = current.getParent();
    hops++;
  }
  return false;
}

const DISABLED_TEST =
  /\b(?:is)?(?:disabled|readOnly|readonly|locked|completed|isComplete|done|unavailable|notAvailable)\b|!\s*\w*(?:available|enabled|editable)\b/i;

/** Nearest enclosing ternary branch, so mutually exclusive classes never pair. */
function branchKey(node: Node): string {
  let current: Node | undefined = node;
  const parts: string[] = [];
  let hops = 0;
  while (current && hops < 40) {
    const parent: Node | undefined = current.getParent();
    if (parent && Node.isConditionalExpression(parent)) {
      parts.push(parent.getWhenTrue() === current ? `${parent.getPos()}T` : `${parent.getPos()}F`);
    }
    current = parent;
    hops++;
  }
  return parts.reverse().join("/");
}

/**
 * Two class tokens coexist when neither sits in a ternary branch the other rules
 * out. Branch paths run outer to inner, so that is exactly a prefix test — an
 * unconditional `hover:` token (empty path) pairs with the resting colour in
 * every branch, while two sibling branches never pair with each other.
 */
export function branchesCoexist(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === "" || b === "";
}

function conditionalTests(node: Node): string {
  let current: Node | undefined = node;
  const tests: string[] = [];
  let hops = 0;
  while (current && hops < 40) {
    const parent: Node | undefined = current.getParent();
    if (parent && Node.isConditionalExpression(parent)) {
      const onTrueSide = parent.getWhenTrue() === current;
      tests.push(`${onTrueSide ? "+" : "-"}${parent.getCondition().getText()}`);
    }
    current = parent;
    hops++;
  }
  return tests.join(" ");
}

/**
 * The class-string root a token belongs to: the JSX attribute, the `.className =`
 * assignment, or the variable it is declared in. Every ramp token sharing a root
 * paints the same element, which is what makes resting/state pairing sound.
 */
function rootFor(
  node: Node,
  icons: Set<string>
): { key: string; element?: ElementInfo; root: Node } {
  let current: Node | undefined = node;
  let hops = 0;
  while (current && hops < 60) {
    if (Node.isJsxAttribute(current) && /^class(?:Name)?$/.test(current.getNameNode().getText())) {
      const opening = current.getFirstAncestor(
        (ancestor): ancestor is JsxOpeningElement | JsxSelfClosingElement =>
          Node.isJsxOpeningElement(ancestor) || Node.isJsxSelfClosingElement(ancestor)
      );
      return {
        key: `${current.getSourceFile().getFilePath()}#${current.getPos()}`,
        element: opening ? describeElement(opening, icons) : undefined,
        root: current,
      };
    }
    if (Node.isBinaryExpression(current) && current.getOperatorToken().getText().endsWith("=")) {
      return {
        key: `${current.getSourceFile().getFilePath()}#${current.getPos()}`,
        root: current,
      };
    }
    if (Node.isVariableDeclaration(current) || Node.isPropertyAssignment(current)) {
      return {
        key: `${current.getSourceFile().getFilePath()}#${current.getPos()}`,
        root: current,
      };
    }
    current = current.getParent();
    hops++;
  }
  return { key: `${node.getSourceFile().getFilePath()}#${node.getPos()}`, root: node };
}

export type SemanticToken = { role: string; variants: string; branch: string };

/**
 * The solid `text-text-*` tokens already on a class root. A ramp token whose band
 * would land on the same role as one of these erases a distinction the control is
 * already drawing — either a state (`hover:text-text-primary`) or the other arm
 * of a ternary (`isSelected ? "text-text-primary" : "text-daintree-text/85"`).
 */
function semanticTokens(root: Node): SemanticToken[] {
  const found: SemanticToken[] = [];
  const literals = [
    ...root.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...root.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ...root.getDescendantsOfKind(SyntaxKind.TemplateHead),
    ...root.getDescendantsOfKind(SyntaxKind.TemplateMiddle),
    ...root.getDescendantsOfKind(SyntaxKind.TemplateTail),
  ];
  for (const literal of literals) {
    const text = literal.getText();
    if (!text.includes("text-text-")) continue;
    const branch = branchKey(literal);
    SEMANTIC_TOKEN.lastIndex = 0;
    for (const match of text.matchAll(SEMANTIC_TOKEN)) {
      found.push({ role: match[2]!, variants: match[1] ?? "", branch });
    }
  }
  return found;
}

type RawSite = {
  file: string;
  line: number;
  start: number;
  end: number;
  token: string;
  variants: string;
  step: number;
  group: string;
  branch: string;
  siblings: string[];
  element?: ElementInfo;
  opacityAncestor: boolean;
  conditional: string;
  iconImport: boolean;
  /** Solid `text-text-*` tokens already on this control, with where they apply. */
  semantic: SemanticToken[];
};

function literalNodes(sourceFile: SourceFile): Node[] {
  const kinds = [
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateHead,
    SyntaxKind.TemplateMiddle,
    SyntaxKind.TemplateTail,
    SyntaxKind.JsxText,
  ];
  return kinds.flatMap((kind) => sourceFile.getDescendantsOfKind(kind) as unknown as Node[]);
}

export type Inventory = { sites: RawSite[]; comments: Map<string, [number, number][]> };

export function collectSites(files?: string[]): Inventory {
  const targets: string[] = [];
  if (files) targets.push(...files.map((file) => path.join(REPO_ROOT, file)));
  else {
    const all: string[] = [];
    for (const root of ROOTS) collectSourceFiles(root, all);
    for (const file of all) {
      if (fs.readFileSync(file, "utf8").includes("text-daintree-text/")) targets.push(file);
    }
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: 4 },
  });

  const sites: RawSite[] = [];
  const comments = new Map<string, [number, number][]>();
  for (const file of targets) {
    const sourceFile = project.addSourceFileAtPath(file);
    const relative = path.relative(REPO_ROOT, file);
    const icons = importedIconNames(sourceFile);
    comments.set(relative, commentRanges(sourceFile));

    for (const literal of literalNodes(sourceFile)) {
      const text = literal.getText();
      if (!text.includes("text-daintree-text/")) continue;
      const base = literal.getPos() + literal.getLeadingTriviaWidth();
      const root = rootFor(literal, icons);
      const semantic = semanticTokens(root.root);
      const siblings = text.split(/[\s"'`]+/).filter(Boolean);
      const opacityAncestor = hasOpacityAncestor(literal) || siblings.some(isCompositingOpacity);

      RAMP_TOKEN.lastIndex = 0;
      for (const match of text.matchAll(RAMP_TOKEN)) {
        const start = base + match.index;
        sites.push({
          file: relative,
          line: sourceFile.getLineAndColumnAtPos(start).line,
          start,
          end: start + match[0].length,
          token: match[0],
          variants: match[1] ?? "",
          step: Number(match[2]),
          group: root.key,
          branch: branchKey(literal),
          siblings,
          element: root.element,
          opacityAncestor,
          conditional: conditionalTests(literal),
          iconImport: root.element ? icons.has(root.element.tag) : false,
          semantic,
        });
      }
    }
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  return { sites, comments };
}

type Verdict = { decision: "migrate" | "keep"; category: Occurrence["category"]; evidence: string };

function carveOut(site: RawSite): Verdict | null {
  if (TEST_FILE.test(site.file)) {
    return {
      decision: "keep",
      category: "test-assertion",
      evidence: "test file — assertions on class strings are rewritten by hand, not by codemod",
    };
  }
  if (isPlaceholderVariant(site.variants)) {
    return {
      decision: "keep",
      category: "placeholder-variant",
      evidence: "placeholder: variant — flattening it would read as real input text",
    };
  }
  if (site.opacityAncestor) {
    return {
      decision: "keep",
      category: "opacity-composite",
      evidence: "opacity-* on the element or a static ancestor composites through this text",
    };
  }
  if (
    site.siblings.some((token) => /(?:^|:)(?:cursor-not-allowed|line-through)$/.test(token)) ||
    DISABLED_TEST.test(site.conditional)
  ) {
    return {
      decision: "keep",
      category: "disabled-state",
      evidence: "disabled, completed or struck-through state — the low contrast is the signal",
    };
  }
  const element = site.element;
  if (element) {
    if (site.iconImport || KNOWN_ICON_TAGS.has(element.tag) || ICON_TAG.test(element.tag)) {
      return {
        decision: "keep",
        category: "icon-affordance",
        evidence: `<${element.tag}> is an icon — the colour is an affordance, not prose`,
      };
    }
    if (site.siblings.some((token) => token.includes("[&_svg]"))) {
      return {
        decision: "keep",
        category: "icon-affordance",
        evidence: "styles a descendant svg rather than text",
      };
    }
    if (element.iconOnly) {
      return {
        decision: "keep",
        category: "icon-affordance",
        evidence: `<${element.tag}> wraps only icons — the colour paints a glyph through currentColor`,
      };
    }
    if (element.ariaHidden && !element.hasTextChild) {
      return {
        decision: "keep",
        category: "decorative-glyph",
        evidence: "aria-hidden with no text content — decorative",
      };
    }
    if (element.singleGlyphChild) {
      return {
        decision: "keep",
        category: "decorative-glyph",
        evidence: "single non-word glyph (separator, chevron, bullet)",
      };
    }
  }
  return null;
}

export function classify(sites: RawSite[]): Occurrence[] {
  const byRoot = new Map<string, RawSite[]>();
  for (const site of sites) {
    const bucket = byRoot.get(site.group);
    if (bucket) bucket.push(site);
    else byRoot.set(site.group, [site]);
  }

  const verdicts = new Map<RawSite, Verdict>();
  for (const site of sites) {
    const carve = carveOut(site);
    if (carve) verdicts.set(site, carve);
  }

  const targets = new Map<RawSite, TextRole>();

  for (const group of byRoot.values()) {
    // `disabled:hover:` is both, and disabled wins: a control that cannot be
    // interacted with has no live affordance to preserve.
    const suppressors = group.filter((site) => isDisabledVariant(site.variants));
    const stateful = group.filter(
      (site) => isStateVariant(site.variants) && !isDisabledVariant(site.variants)
    );
    const resting = group.filter(
      (site) => !isStateVariant(site.variants) && !isDisabledVariant(site.variants)
    );
    const partners = (site: RawSite): RawSite[] =>
      resting.filter((other) => branchesCoexist(other.branch, site.branch));

    // A carve-out on either end takes the whole control with it: resting and
    // state only mean anything relative to each other, and moving one while the
    // other stays on the ramp is how the hover direction inverts.
    for (const state of [...stateful, ...suppressors]) {
      const control = [state, ...partners(state)];
      const carve = control.map((site) => verdicts.get(site)).find(Boolean);
      if (!carve) continue;
      for (const site of control) {
        if (verdicts.has(site)) continue;
        verdicts.set(site, {
          ...carve,
          evidence: `${carve.evidence} (state pair retained together)`,
        });
      }
    }

    for (const site of group) {
      if (verdicts.has(site)) continue;
      const role = bandFor(site.step);
      if (role) targets.set(site, role);
    }

    // #12003 held 31 `/40` sites dim purely because their state partner was
    // still on the ramp. Moving the partner is what unblocks them.
    for (const site of resting) {
      if (site.step !== 40 || verdicts.has(site)) continue;
      const reopens = stateful.some(
        (state) =>
          !verdicts.has(state) && targets.has(state) && branchesCoexist(state.branch, site.branch)
      );
      if (reopens) targets.set(site, "secondary");
    }

    // A ramp token can share a control with a solid token that already draws the
    // distinction the ramp step was drawing. Two shapes, one consequence:
    //
    //   text-daintree-text/80 hover:text-text-primary
    //   isSelected ? "text-text-primary" : "text-daintree-text/85"
    //
    // Both put `/80`-ish prose beside `text-primary`. `/80` measures 6.0:1 at its
    // floor against `text-secondary`'s 5.0:1, so it cannot be demoted to keep the
    // difference, and raising it to its band role would erase the difference
    // instead. Leaving the pair on the ramp is the only move that keeps the floor
    // and the distinction both.
    for (const site of group) {
      if (verdicts.has(site)) continue;
      const role = targets.get(site);
      if (!role) continue;
      const rival = site.semantic.find((token) => {
        const rank = ROLE_RANK[token.role];
        if (rank === undefined || ROLE_RANK[role]! < rank) return false;
        // A state variant competes when it applies to the same render; a bare
        // token competes only from a branch this one rules out.
        return isStateVariant(token.variants) && !isDisabledVariant(token.variants)
          ? branchesCoexist(token.branch, site.branch)
          : token.variants === "" && !branchesCoexist(token.branch, site.branch);
      });
      if (!rival) continue;
      const control = [
        site,
        ...group.filter((other) => other !== site && branchesCoexist(other.branch, site.branch)),
      ];
      for (const member of control) {
        targets.delete(member);
        verdicts.set(member, {
          decision: "keep",
          category: "semantic-state-pair",
          evidence: `${rival.variants || "another branch"} already paints text-text-${rival.role} here; the band role would erase the difference`,
        });
      }
    }

    // `disabled:hover:text-…/40` beside a resting `/40` is a hover *suppressor*:
    // it exists to pin the disabled control back to its resting colour. It has to
    // land on whatever the resting end landed on, or the suppression breaks — the
    // one genuine inversion the first pass produced was exactly this.
    for (const suppressor of suppressors) {
      if (verdicts.has(suppressor)) continue;
      const twin = partners(suppressor).find((site) => site.step === suppressor.step);
      const role = twin ? targets.get(twin) : undefined;
      if (role) targets.set(suppressor, role);
    }

    // A pair whose ends land on the same role loses its affordance entirely.
    // Promote the state end instead: `text-text-secondary hover:text-text-primary`
    // is already the codebase's dominant idiom (372 uses against 13 of the
    // alternative), and promotion only ever raises a contrast floor, so it cannot
    // violate the floor-non-regression rule the bands are built on.
    //
    // Disabled variants are deliberately excluded. `disabled:hover:text-…/70`
    // beside a resting `/70` is a hover *suppressor* — brightening it would
    // invent a hover state on a control that has none.
    for (const state of stateful) {
      if (verdicts.has(state) || isDisabledVariant(state.variants)) continue;
      const stateRole = targets.get(state);
      if (!stateRole) continue;
      const restingRoles = partners(state)
        .map((site) => targets.get(site))
        .filter((role): role is TextRole => role !== undefined);
      if (restingRoles.length === 0) continue;
      const brightest = restingRoles.reduce((a, b) =>
        ROLE_ORDER.indexOf(a) >= ROLE_ORDER.indexOf(b) ? a : b
      );
      if (ROLE_ORDER.indexOf(stateRole) > ROLE_ORDER.indexOf(brightest)) continue;
      targets.set(state, promote(brightest));
    }
  }

  return sites.map((site) => {
    const verdict = verdicts.get(site);
    if (verdict) {
      return {
        file: site.file,
        line: site.line,
        start: site.start,
        end: site.end,
        token: site.token,
        variants: site.variants,
        step: site.step,
        group: site.group,
        branch: site.branch,
        ...verdict,
      };
    }

    const target = targets.get(site);
    if (!target) {
      return {
        file: site.file,
        line: site.line,
        start: site.start,
        end: site.end,
        token: site.token,
        variants: site.variants,
        step: site.step,
        group: site.group,
        branch: site.branch,
        decision: "keep" as const,
        category: "prior-ruling-40" as const,
        evidence: "#12003 ruled on this /40 site; no in-scope partner reopens it",
      };
    }

    const band = bandFor(site.step);
    const promoted = band !== null && target !== band;
    return {
      file: site.file,
      line: site.line,
      start: site.start,
      end: site.end,
      token: site.token,
      variants: site.variants,
      step: site.step,
      group: site.group,
      branch: site.branch,
      decision: "migrate" as const,
      category: site.step === 40 ? "pair-reopened-40" : promoted ? "pair-promoted" : "band",
      target: replacementToken(site.variants, target),
      evidence:
        site.step === 40
          ? "reopened: shares a control with an in-scope state token"
          : promoted
            ? `promoted to keep the state distinct from its resting colour`
            : `measured band /${site.step} → ${roleClass(target)}`,
    };
  });
}

/**
 * The AST pass plus whatever the lexical scan saw that it did not. A leftover
 * inside a comment is prose and gets its own category; a leftover anywhere else
 * is a blind spot in the walker, and it stays in the manifest as `unaccounted`
 * so `--check` fails loudly instead of the site disappearing.
 */
function buildManifest(): Manifest {
  const inventory = collectSites();
  const occurrences = classify(inventory.sites);
  const seen = new Map<string, number>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.file}:${occurrence.start}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  for (const hit of lexicalScan()) {
    if (seen.has(`${hit.file}:${hit.start}`)) continue;
    const inComment = (inventory.comments.get(hit.file) ?? []).some(
      ([from, to]) => hit.start >= from && hit.start < to
    );
    occurrences.push({
      file: hit.file,
      line: hit.line,
      start: hit.start,
      end: hit.end,
      token: hit.token,
      variants: "",
      step: Number(hit.token.split("/").pop()),
      group: `${hit.file}#comment`,
      branch: "",
      decision: "keep",
      category: inComment ? "comment-reference" : "unaccounted",
      evidence: inComment
        ? "named in prose, not a painted site"
        : "UNACCOUNTED — reached by the lexical scan but not by the AST walker",
    });
  }

  occurrences.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  return {
    generated: new Date().toISOString().slice(0, 10),
    total: occurrences.length,
    files: new Set(occurrences.map((occurrence) => occurrence.file)).size,
    occurrences,
  };
}

function readManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`No manifest at ${path.relative(REPO_ROOT, MANIFEST_PATH)} — run with --plan`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

function report(manifest: Manifest): void {
  const lexical = lexicalScan();
  const steps = [...new Set(manifest.occurrences.map((o) => o.step))].sort((a, b) => a - b);

  console.log(
    `\ntext-daintree-text ramp — ${manifest.total} occurrences in ${manifest.files} files\n`
  );
  console.log("step  total  migrate  keep   categories");
  for (const step of steps) {
    const rows = manifest.occurrences.filter((o) => o.step === step);
    const migrate = rows.filter((o) => o.decision === "migrate").length;
    const categories = new Map<string, number>();
    for (const row of rows.filter((o) => o.decision === "keep")) {
      categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
    }
    const summary = [...categories.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} ${count}`)
      .join(", ");
    console.log(
      `/${String(step).padEnd(4)}${String(rows.length).padStart(5)}${String(migrate).padStart(9)}` +
        `${String(rows.length - migrate).padStart(6)}   ${summary}`
    );
  }

  const migrated = manifest.occurrences.filter((o) => o.decision === "migrate");
  const kept = manifest.occurrences.filter((o) => o.decision === "keep");
  console.log(`\nmigrate ${migrated.length}   keep ${kept.length}   total ${manifest.total}`);

  const byTarget = new Map<string, number>();
  for (const row of migrated) {
    const role = row.target!.split(":").pop()!;
    byTarget.set(role, (byTarget.get(role) ?? 0) + 1);
  }
  console.log("\ndestination roles");
  for (const [role, count] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${role.padEnd(24)} ${count}`);
  }

  const byCategory = new Map<string, number>();
  for (const row of kept) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
  console.log("\nretained carve-outs");
  for (const [name, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(24)} ${count}`);
  }

  const unaccounted = manifest.occurrences.filter((o) => o.category === "unaccounted").length;
  console.log(
    `\nreconciliation: lexical ${lexical.length}, classified ${manifest.total}, ` +
      `unaccounted ${unaccounted} — ${lexical.length === manifest.total && unaccounted === 0 ? "clean" : "MISMATCH"}`
  );
}

/**
 * Every control whose colour changes with state, resting end beside state end,
 * before and after. #12065 asks for hover direction to be "verified rather than
 * assumed": a pair whose state end resolves no brighter than its resting end has
 * lost its affordance, and this is what proves none did.
 */
function pairs(manifest: Manifest): number {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of manifest.occurrences) {
    if (occurrence.category === "comment-reference") continue;
    const bucket = groups.get(occurrence.group);
    if (bucket) bucket.push(occurrence);
    else groups.set(occurrence.group, [occurrence]);
  }

  // Kept sites rank by their step, migrated ones by role. Mixing the two scales
  // is the point: a pair with one end on each is exactly the mixed pair that
  // inverts, and this is what surfaces it.
  const rank = (occurrence: Occurrence): number => {
    if (occurrence.decision === "keep") return occurrence.step / 100;
    const role = occurrence.target!.split("text-text-").pop() as TextRole;
    return 1 + ROLE_ORDER.indexOf(role);
  };

  let inverted = 0;
  let printed = 0;
  console.log("\nstate pairs (resting → state)\n");
  for (const group of groups.values()) {
    const stateful = group.filter(
      (o) => isStateVariant(o.variants) || isDisabledVariant(o.variants)
    );
    const resting = group.filter(
      (o) => !isStateVariant(o.variants) && !isDisabledVariant(o.variants)
    );

    for (const state of stateful) {
      const restEnd = resting.find((o) => branchesCoexist(o.branch, state.branch));
      if (!restEnd) continue;
      const shown = (o: Occurrence): string =>
        o.decision === "migrate" ? o.target! : `${o.token} (kept)`;
      const delta = rank(state) - rank(restEnd);
      // A suppressor is meant to match its resting colour, so equal is correct
      // there and only a genuine drop counts against it.
      const suppressor = isDisabledVariant(state.variants);
      const bad = suppressor ? delta < 0 : delta <= 0;
      if (bad) inverted++;
      console.log(
        `${bad ? "! " : "  "}${restEnd.file}:${restEnd.line}  ` +
          `${`/${restEnd.step} → /${state.step}`.padEnd(16)} ${shown(restEnd)} → ${shown(state)}`
      );
      printed++;
    }
  }
  console.log(
    `\n${printed} pair(s); ${inverted} without a distinct state colour — ` +
      `${inverted === 0 ? "every affordance survives" : "AFFORDANCE LOST"}`
  );
  return inverted === 0 ? 0 : 1;
}

function apply(manifest: Manifest): void {
  const byFile = new Map<string, Occurrence[]>();
  for (const occurrence of manifest.occurrences) {
    if (occurrence.decision !== "migrate") continue;
    const bucket = byFile.get(occurrence.file);
    if (bucket) bucket.push(occurrence);
    else byFile.set(occurrence.file, [occurrence]);
  }

  let rewritten = 0;
  for (const [file, occurrences] of byFile) {
    const absolute = path.join(REPO_ROOT, file);
    let source = fs.readFileSync(absolute, "utf8");
    for (const occurrence of [...occurrences].sort((a, b) => b.start - a.start)) {
      const found = source.slice(occurrence.start, occurrence.end);
      if (found !== occurrence.token) {
        throw new Error(
          `${file}:${occurrence.line} — expected \`${occurrence.token}\` at ${occurrence.start}, found \`${found}\`. Re-run --plan.`
        );
      }
      source =
        source.slice(0, occurrence.start) + occurrence.target! + source.slice(occurrence.end);
      rewritten++;
    }
    fs.writeFileSync(absolute, source);
  }
  console.log(`rewrote ${rewritten} occurrences across ${byFile.size} files`);
}

function check(manifest: Manifest): number {
  const lexical = lexicalScan();
  const accounted = new Map<string, Occurrence>();
  for (const occurrence of manifest.occurrences) {
    if (occurrence.decision === "keep")
      accounted.set(`${occurrence.file}:${occurrence.start}`, occurrence);
  }

  const problems: string[] = [];
  for (const hit of lexical) {
    const match = accounted.get(`${hit.file}:${hit.start}`);
    if (!match) problems.push(`${hit.file}:${hit.line}  ${hit.token} — no manifest entry`);
    else if (match.token !== hit.token) {
      problems.push(`${hit.file}:${hit.line}  expected ${match.token}, found ${hit.token}`);
    } else if (match.category === "unaccounted") {
      problems.push(`${hit.file}:${hit.line}  ${hit.token} — no named carve-out`);
    }
  }
  for (const [key, occurrence] of accounted) {
    if (!lexical.some((hit) => `${hit.file}:${hit.start}` === key)) {
      problems.push(
        `${occurrence.file}:${occurrence.line}  ${occurrence.token} — manifest entry no longer in the tree`
      );
    }
  }

  if (problems.length > 0) {
    console.error(`${problems.length} ramp accounting problem(s):`);
    for (const problem of problems.slice(0, 25)) console.error(`  ${problem}`);
    if (problems.length > 25) console.error(`  … and ${problems.length - 25} more`);
    console.error("Re-run `npm run theme:text-ramp -- --plan`.");
    return 1;
  }

  const categories = new Map<string, number>();
  for (const occurrence of accounted.values()) {
    categories.set(occurrence.category, (categories.get(occurrence.category) ?? 0) + 1);
  }
  console.log(`${lexical.length} retained ramp occurrence(s), every one in a named carve-out:`);
  for (const [name, count] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(24)} ${count}`);
  }
  return 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--plan")) {
    const manifest = buildManifest();
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${path.relative(REPO_ROOT, MANIFEST_PATH)} (${manifest.total} occurrences)`);
    report(manifest);
    return;
  }
  if (argv.includes("--pairs")) {
    process.exitCode = pairs(buildManifest());
    return;
  }
  if (argv.includes("--apply")) {
    apply(readManifest());
    return;
  }
  if (argv.includes("--check")) {
    process.exitCode = check(readManifest());
    return;
  }
  report(buildManifest());
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
