import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_STATUS_SUCCESS_OCCURRENCES,
  EXPECTED_STATUS_SUCCESS_SITES,
  STATUS_SUCCESS_CATEGORIES,
  STATUS_SUCCESS_INVENTORY,
  type ApprovedStatusSuccessSite,
} from "./statusSuccessInventory";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
// The builtin plugin renderers ship in the app and paint the same tokens, so
// they are production surfaces, not third-party code. `accentGuard` already
// scans this root for the same reason.
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];
const POLICY_DOC = "docs/themes/status-success-policy.md";

// ── What counts as a paint site ────────────────────────────────────────

/**
 * Every Tailwind v4 utility that can take a colour. Enumerated rather than
 * matched loosely, because two real classes in this repo end in the same
 * substring without painting the token: `forge-status-success` (an animation)
 * and `bg-status-success-surface` (a different token). A loose rule would flag
 * both, and a guard that cries wolf gets deleted.
 */
const COLOUR_UTILITY_ROOTS = [
  "bg",
  "text",
  "border",
  "border-(?:[trblxyse]|bs|be)",
  "outline",
  "ring",
  "ring-offset",
  "inset-ring",
  "divide",
  "fill",
  "stroke",
  "accent",
  "caret",
  "decoration",
  "placeholder",
  "shadow",
  "inset-shadow",
  "text-shadow",
  "drop-shadow",
  "from",
  "via",
  "to",
  "mask-from",
  "mask-via",
  "mask-to",
].join("|");

/**
 * Everything Tailwind v4 accepts after the slash: a bare number (fractional
 * included), a bracketed value, or the shorthand variable form.
 */
const ALPHA_MODIFIER = "(?:\\/(?:\\d+(?:\\.\\d+)?|\\[[^\\]]*\\]|\\([^)]*\\)))?";

/**
 * A utility painting with the success token — variants, opacity modifier and
 * the important marker included, since none of them changes what it paints:
 * `bg-status-success`, `hover:text-status-success/70`,
 * `data-[state=on]:border-status-success/30`, `bg-status-success!`.
 * Anchored both ends so the two lookalike classes above stay out.
 */
const PAINT_UTILITY = new RegExp(
  `(?:^|:)!?(?:${COLOUR_UTILITY_ROOTS})-status-success${ALPHA_MODIFIER}!?$`
);

/**
 * The variable shorthand — `bg-(--color-status-success)` — reaches the token
 * without ever spelling the utility suffix, so it needs its own shape.
 */
const PAINT_VAR_SHORTHAND = new RegExp(
  `(?:^|:)!?(?:${COLOUR_UTILITY_ROOTS})-\\(--color-status-success\\)${ALPHA_MODIFIER}!?$`
);

/** The same colour reached through the variable, as arbitrary values do. */
const PAINT_VAR = "var(--color-status-success)";

/**
 * Only painting is governed, not defining. `applyAppTheme` and
 * `ColorVisionPicker` name the token (`"status-success"`,
 * `"--theme-status-success"`) to build and preview the palette; the ruling
 * protects `--color-status-success` itself, so the layer that defines it is
 * outside this guard by construction.
 */
function isPaintLexeme(lexeme: string): boolean {
  return (
    PAINT_UTILITY.test(lexeme) || PAINT_VAR_SHORTHAND.test(lexeme) || lexeme.includes(PAINT_VAR)
  );
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function statusSuccessSignature(literalText: string): string {
  return normalise(literalText).split(" ").filter(isPaintLexeme).join(" ");
}

interface PaintSite {
  file: string;
  line: number;
  signature: string;
  occurrences: number;
  /** Enclosing node texts, innermost first. */
  ancestors: string[];
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * The decoded text of any literal a className can live in — quoted strings and
 * every quasi of a template — or null for everything else. Decoded, so quote
 * style and escaping never reach the signature.
 */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddleOrTemplateTail(node)) return node.text;
  return null;
}

/**
 * Parsed rather than grepped, so a `status-success` mentioned in a comment —
 * `projectRowStatus` and `PilotRunState` both explain their token choices in
 * prose — is not mistaken for a paint site.
 */
export function scanPaintSites(relativePath: string, sourceText: string): PaintSite[] {
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const sites: PaintSite[] = [];

  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== null) {
      const signature = statusSuccessSignature(text);
      if (signature.length > 0) {
        const ancestors: string[] = [];
        for (let cur = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
          ancestors.push(normalise(cur.getText(source)));
        }
        sites.push({
          file: relativePath,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          signature,
          occurrences: signature.split(" ").length,
          ancestors,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return sites;
}

// ── Anchor resolution ──────────────────────────────────────────────────

/**
 * Depth of the innermost enclosing node containing `anchor`, or -1.
 *
 * Depth is what makes anchors work inside tight config maps. `STATUS_CONFIG`
 * contains every one of its own entries, so an anchor lifted from the `added`
 * entry is technically present in the `untracked` entry's ancestor chain too —
 * just several levels further out. The nearest match wins.
 */
export function anchorDepth(site: PaintSite, anchor: string): number {
  for (let depth = 0; depth < site.ancestors.length; depth++) {
    if (site.ancestors[depth]!.includes(anchor)) return depth;
  }
  return -1;
}

function matches(
  site: PaintSite,
  approval: ApprovedStatusSuccessSite,
  twins: PaintSite[]
): boolean {
  if (site.signature !== approval.signature) return false;
  if (approval.anchor === undefined) return true;

  const depth = anchorDepth(site, approval.anchor);
  if (depth < 0) return false;
  return twins.every((twin) => {
    if (twin === site) return true;
    const other = anchorDepth(twin, approval.anchor!);
    return other < 0 || other > depth;
  });
}

// ── The scan ───────────────────────────────────────────────────────────

const discovered: PaintSite[] = SCAN_ROOTS.flatMap((root) =>
  fs.existsSync(root) ? collectSourceFiles(root) : []
).flatMap((absolute) => {
  const source = fs.readFileSync(absolute, "utf8");
  if (!source.includes("status-success")) return [];
  const relative = path.relative(REPO_ROOT, absolute).replace(/\\/g, "/");
  return scanPaintSites(relative, source);
});

const sitesByFile = new Map<string, PaintSite[]>();
for (const site of discovered) {
  const list = sitesByFile.get(site.file);
  if (list) list.push(site);
  else sitesByFile.set(site.file, [site]);
}

type Approval = ApprovedStatusSuccessSite & { file: string };

const inventoryByFile = new Map<string, readonly ApprovedStatusSuccessSite[]>(
  Object.entries(STATUS_SUCCESS_INVENTORY)
);

const approvals: Approval[] = [...inventoryByFile].flatMap(([file, entries]) =>
  entries.map((entry) => ({ ...entry, file }))
);

function sitesFor(approval: Approval): PaintSite[] {
  const inFile = sitesByFile.get(approval.file) ?? [];
  const twins = inFile.filter((site) => site.signature === approval.signature);
  return twins.filter((site) => matches(site, approval, twins));
}

const FIX_INSTRUCTIONS =
  `Ask the review question: can this green be named as a specific result, a required checked ` +
  `item, or a live operation? If not, it does not get to persist.\n` +
  `  - Ambient health, threshold baselines, membership and settled completion go neutral ` +
  `(bg-overlay-subtle, border-border-default, text-text-secondary) or disappear.\n` +
  `  - A live process keeps its green on activity-working / state-working, which is not this guard's token.\n` +
  `  - Anything that stays green needs an entry in statusSuccessInventory.ts declaring one of ` +
  `${STATUS_SUCCESS_CATEGORIES.join(" / ")} and a rationale naming it.\n` +
  `See ${POLICY_DOC}.`;

describe("status-success guard", () => {
  describe("what the scanner counts", () => {
    it("keeps utilities and variable reads, drops token names and lookalike classes", () => {
      const cases: Array<[string, string]> = [
        ["w-2 h-2 rounded-full bg-status-success shrink-0", "bg-status-success"],
        [
          "hover:text-status-success/70 border-status-success/50",
          "hover:text-status-success/70 border-status-success/50",
        ],
        [
          "bg-[color-mix(in_oklab,var(--color-status-success)_10%,transparent)]",
          "bg-[color-mix(in_oklab,var(--color-status-success)_10%,transparent)]",
        ],
        // Variants, the important marker and the opacity modifier all change
        // nothing about what gets painted.
        ["!bg-status-success", "!bg-status-success"],
        ["bg-status-success!", "bg-status-success!"],
        ["[&>svg]:text-status-success", "[&>svg]:text-status-success"],
        ["supports-[display:grid]:bg-status-success", "supports-[display:grid]:bg-status-success"],
        // Colour utilities that are easy to leave off an enumerated list.
        ["ring-offset-status-success", "ring-offset-status-success"],
        ["inset-ring-status-success", "inset-ring-status-success"],
        ["placeholder-status-success", "placeholder-status-success"],
        ["text-shadow-status-success", "text-shadow-status-success"],
        ["border-s-status-success", "border-s-status-success"],
        ["from-status-success via-status-success", "from-status-success via-status-success"],
        // An unrelated animation class that merely contains the substring.
        ["forge-status-success", ""],
        // The theme layer naming the token rather than painting with it.
        ["status-success", ""],
        ["--theme-status-success", ""],
        // A different token that shares the prefix, and a non-colour utility.
        ["bg-status-success-surface", ""],
        ["my-status-success", ""],
        // `selection` and `marker` are variants, not colour utilities — Tailwind
        // emits nothing for the bare form, so only the variant spelling counts.
        ["selection:bg-status-success", "selection:bg-status-success"],
        ["selection-status-success", ""],
        ["marker-status-success", ""],
      ];
      for (const [input, expected] of cases) {
        expect(statusSuccessSignature(input), input).toBe(expected);
      }
    });

    it("reads literals, not comments", () => {
      const sites = scanPaintSites(
        "sample.tsx",
        `// text-status-success in prose is not a paint site\nconst a = "bg-status-success";\n`
      );
      expect(sites.map((s) => s.signature)).toEqual(["bg-status-success"]);
    });

    it("counts one literal painting several utilities as one site", () => {
      const sites = scanPaintSites(
        "sample.tsx",
        `const a = "bg-status-success/10 text-status-success border-status-success/30";\n`
      );
      expect(sites).toHaveLength(1);
      expect(sites[0]?.occurrences).toBe(3);
    });

    it("resolves an anchor to its innermost enclosing node", () => {
      const [site] = scanPaintSites(
        "sample.ts",
        `const CONFIG = { added: { label: "A", color: "text-status-success" } };\n`
      );
      expect(site).toBeDefined();
      // `label: "A"` sits closer to the literal than the outer map does.
      expect(anchorDepth(site!, 'label: "A"')).toBeLessThan(anchorDepth(site!, "const CONFIG"));
    });
  });

  it("has no unclassified status-success paint site", () => {
    const unclassified = discovered.filter((site) => {
      const inFile = sitesByFile.get(site.file) ?? [];
      const twins = inFile.filter((other) => other.signature === site.signature);
      const entries = inventoryByFile.get(site.file) ?? [];
      return !entries.some((entry) => matches(site, entry, twins));
    });

    const report = unclassified
      .map((site) => `  ${site.file}:${site.line}\n    signature: ${site.signature}`)
      .join("\n");

    expect(
      unclassified.map((site) => `${site.file}:${site.line}`),
      `Found ${unclassified.length} status-success paint site(s) with no inventory entry:\n${report}\n\n${FIX_INSTRUCTIONS}`
    ).toEqual([]);
  });

  it("maps every site to exactly one approval", () => {
    // Two approvals matching one site would let a real occurrence disappear
    // while its twin's entry silently covered the survivor.
    const ambiguous = discovered
      .map((site) => {
        const inFile = sitesByFile.get(site.file) ?? [];
        const twins = inFile.filter((other) => other.signature === site.signature);
        const hits = (inventoryByFile.get(site.file) ?? []).filter((entry) =>
          matches(site, entry, twins)
        );
        return { site, hits: hits.length };
      })
      .filter(({ hits }) => hits > 1)
      .map(({ site, hits }) => `  ${site.file}:${site.line} matched by ${hits} entries`);

    expect(
      ambiguous,
      `Entries overlap — give each a narrower anchor:\n${ambiguous.join("\n")}`
    ).toEqual([]);
  });

  it("has no stale inventory entries", () => {
    const stale: string[] = [];

    for (const approval of approvals) {
      const hits = sitesFor(approval);
      if (hits.length === 0) {
        stale.push(
          `  ${approval.file} — no site matches signature "${approval.signature}"` +
            (approval.anchor ? ` anchored on "${approval.anchor}"` : "")
        );
        continue;
      }
      if (hits.length > 1) {
        stale.push(
          `  ${approval.file} — signature "${approval.signature}" matches ${hits.length} sites ` +
            `(lines ${hits.map((h) => h.line).join(", ")}); give each entry a distinguishing anchor`
        );
        continue;
      }
      const [only] = hits;
      if (only!.occurrences !== approval.expectedOccurrences) {
        stale.push(
          `  ${approval.file}:${only!.line} — expected ${approval.expectedOccurrences} occurrence(s), found ${only!.occurrences}`
        );
      }
    }

    expect(
      stale,
      `Found ${stale.length} inventory entr(ies) that no longer describe the source:\n${stale.join("\n")}\n\n` +
        `The green moved or went away — delete the entry, or re-point it and restate why it is still allowed.\n` +
        `See ${POLICY_DOC}.`
    ).toEqual([]);
  });

  it("gives every entry a category and a rationale", () => {
    const thin = approvals
      .filter(
        (approval) =>
          !STATUS_SUCCESS_CATEGORIES.includes(approval.category) ||
          approval.rationale.trim().length < 20
      )
      .map((approval) => `  ${approval.file}: ${approval.signature}`);

    expect(
      thin,
      `Entries need one of ${STATUS_SUCCESS_CATEGORIES.join(" / ")} and a rationale that names the ` +
        `specific confirmation, item, result or notation:\n${thin.join("\n")}`
    ).toEqual([]);
  });

  it("holds the site and occurrence ratchets", () => {
    const occurrences = discovered.reduce((total, site) => total + site.occurrences, 0);

    // Both, because they fail on different things: a swap that removes one green
    // and adds another somewhere else holds the site count but not the per-site
    // checks, and a file that moves wholesale holds the per-site checks but not
    // these. Going down is as much a signal as going up — update the numbers
    // with the inventory, in the same commit.
    expect(discovered.length, "status-success paint sites in src/").toBe(
      EXPECTED_STATUS_SUCCESS_SITES
    );
    expect(occurrences, "status-success utilities in src/").toBe(
      EXPECTED_STATUS_SUCCESS_OCCURRENCES
    );
    expect(
      approvals.reduce((total, approval) => total + approval.expectedOccurrences, 0),
      "occurrences accounted for by the inventory"
    ).toBe(EXPECTED_STATUS_SUCCESS_OCCURRENCES);
  });

  it("points at the policy doc from its failure output", () => {
    expect(FIX_INSTRUCTIONS).toContain(POLICY_DOC);
    expect(fs.existsSync(path.join(REPO_ROOT, POLICY_DOC))).toBe(true);
  });
});
