import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_THEME_TOKEN_KEYS, PANEL_KIND_BRAND_COLORS } from "@shared/theme";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const RENDERER_ROOTS = [SRC_ROOT, path.join(REPO_ROOT, "plugins/builtin/github/renderer")];
const NON_COLOR_THEME_TOKENS = new Set([
  "shadow-ambient",
  "shadow-floating",
  "shadow-dialog",
  "material-blur",
  "material-saturation",
  "material-opacity",
  "radius-scale",
  "state-chip-bg-opacity",
  "state-chip-border-opacity",
  "label-pill-bg-opacity",
  "label-pill-border-opacity",
  "scrollbar-width",
  "scrollbar-thumb",
  "scrollbar-thumb-hover",
  "scrollbar-track",
  "panel-state-edge-width",
  "panel-state-edge-inset-block",
  "panel-state-edge-radius",
  "focus-ring-offset",
  "chrome-noise-texture",
  "scrim-blur",
  "scrim-blur-palette",
  "grain-opacity",
  "grain-blend",
]);

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        return [];
      }
      return collectSourceFiles(fullPath);
    }

    if (!/\.(ts|tsx|css)$/.test(entry.name)) {
      return [];
    }

    if (/\.(test|spec)\./.test(entry.name)) {
      return [];
    }

    return [fullPath];
  });
}

describe("color system contract", () => {
  const indexCss = fs.readFileSync(INDEX_CSS_PATH, "utf8");
  const exportedColorVars = new Set(
    Array.from(indexCss.matchAll(/--color-([a-z0-9-]+):/g), (match) => match[1]!)
  );

  it("exports every app theme token to the CSS layer", () => {
    for (const token of APP_THEME_TOKEN_KEYS.filter((key) => !NON_COLOR_THEME_TOKENS.has(key))) {
      expect(exportedColorVars.has(token), `Missing --color-${token} export`).toBe(true);
    }
  });

  it("uses only exported theme-style color utilities in renderer source", () => {
    const utilityRegex =
      /\b(?:bg|text|border|ring-offset|ring|outline|divide|accent|placeholder|fill|stroke)-((?:daintree|surface|text|border|accent|status|activity|category|pr|overlay|scrim|state|server|terminal|cat|filter)[a-z0-9-]*)(?:\/[^\s"'`)]+)?/g;

    const missing = new Map<string, string[]>();

    for (const filePath of RENDERER_ROOTS.flatMap(collectSourceFiles)) {
      const source = fs.readFileSync(filePath, "utf8");
      const matches = new Set(Array.from(source.matchAll(utilityRegex), (match) => match[1]!));

      for (const token of matches) {
        if (exportedColorVars.has(token)) {
          continue;
        }

        const relativePath = path.relative(REPO_ROOT, filePath);
        const locations = missing.get(token) ?? [];
        locations.push(relativePath);
        missing.set(token, locations);
      }
    }

    expect(
      Object.fromEntries(
        Array.from(missing.entries()).map(([token, files]) => [token, Array.from(new Set(files))])
      )
    ).toEqual({});
  });

  it("keeps built-in panel kind colors theme-backed", () => {
    for (const [kind, color] of Object.entries(PANEL_KIND_BRAND_COLORS)) {
      expect(color, `${kind} panel color should resolve through theme variables`).toMatch(
        /^var\(--theme-/
      );
    }
  });

  it("exports --color-accent-primary-foreground mapped to --theme-accent-foreground", () => {
    expect(indexCss).toMatch(
      /--color-accent-primary-foreground:\s*var\(--theme-accent-foreground\)/
    );
  });

  // #12031 renamed ~2.3k solid call sites off the legacy `daintree-*` vocabulary
  // onto the semantic tokens it aliased. The rename is only a no-op while both
  // spellings still resolve to the same `--theme-*` terminal, so resolve them
  // through the real declarations rather than trusting the alias block to read
  // the way it did the day it was written.
  it("resolves each surviving daintree-* alias to the same theme token as its replacement", () => {
    const declarations = new Map(
      Array.from(indexCss.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g), (m) => [
        m[1]!,
        m[2]!.trim(),
      ])
    );

    function resolve(name: string): string {
      const seen = new Set<string>();
      let current = name;
      for (;;) {
        if (seen.has(current)) throw new Error(`--color-${name} resolves through a cycle`);
        seen.add(current);
        const value = declarations.get(current);
        expect(value, `--color-${current} is not declared`).toBeDefined();
        const hop = value!.match(/^var\(\s*--color-([a-z0-9-]+)\s*\)$/);
        if (!hop) return value!;
        current = hop[1]!;
      }
    }

    const renames: Record<string, string> = {
      "daintree-bg": "surface-canvas",
      "daintree-sidebar": "surface-sidebar",
      "daintree-border": "border-default",
      "daintree-text": "text-primary",
      "daintree-accent": "accent-primary",
    };

    for (const [legacy, semantic] of Object.entries(renames)) {
      expect(
        resolve(legacy),
        `--color-${legacy} and --color-${semantic} must paint the same colour, or the ` +
          `#12031 rename of every ${legacy.replace("daintree-", "")} call site changed pixels`
      ).toBe(resolve(semantic));
    }
  });

  // The two aliases #12031 deleted had no consumers. Removing a live one would
  // silently stop Tailwind generating the alpha-modified utilities still in the
  // tree — the non-text composites left to #12029 (`ring-daintree-accent/30`),
  // and the ramp carve-outs #12065 kept dim on purpose.
  it("keeps a daintree-* alias declared for every alpha-modified use still in the tree", () => {
    const alphaUse =
      /(?<=[a-z0-9\]])-daintree-(sidebar|border|accent|text|bg)\/(?:\[[\d.]+\]|\d+)/g;

    const needed = new Set<string>();
    for (const filePath of RENDERER_ROOTS.flatMap(collectSourceFiles)) {
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(alphaUse)) needed.add(`daintree-${match[1]!}`);
    }

    const undeclared = Array.from(needed).filter((name) => !exportedColorVars.has(name));
    expect(undeclared, `alpha-modified utilities reference undeclared --color-* aliases`).toEqual(
      []
    );
  });

  // The other half of the #12031 no-op proof. The alias-equality test above shows
  // the mapping is value-preserving; this one shows it was actually applied, so
  // a solid legacy utility cannot creep back in from a copied recipe or a
  // reverted hunk. Alpha-modified forms are deliberately still allowed — they
  // are the deferred ramp.
  it("has no solid daintree-* utility or raw alias read left in renderer source", () => {
    const solidUtility =
      /(?<!--color)(?<=[a-z0-9\]])-daintree-(sidebar|border|accent|text|bg)(?![\w-]|\\*\/)/g;
    const rawRead = /var\(\s*--color-daintree-/g;

    const offenders = new Map<string, string[]>();
    for (const filePath of RENDERER_ROOTS.flatMap(collectSourceFiles)) {
      const source = fs.readFileSync(filePath, "utf8");
      const hits = [
        ...Array.from(source.matchAll(solidUtility), (m) => m[0]!),
        ...Array.from(source.matchAll(rawRead), (m) => m[0]!),
      ];
      if (hits.length > 0) {
        offenders.set(path.relative(REPO_ROOT, filePath), Array.from(new Set(hits)));
      }
    }

    expect(
      Object.fromEntries(offenders),
      `Solid legacy colour utilities are retired — use the semantic token the alias ` +
        `points at (daintree-bg -> surface-canvas, daintree-sidebar -> surface-sidebar, ` +
        `daintree-border -> border-default, daintree-text -> text-primary, ` +
        `daintree-accent -> accent-primary). Alpha-modified forms are still allowed: ` +
        `the non-text composites are #12029's, and #12065 kept a reviewed set of ` +
        `text carve-outs dim on purpose.`
    ).toEqual({});
  });

  /**
   * #12065's accounting, made permanent. The ramp is retired for prose, but a
   * reviewed set of sites stays dim — icon affordances, decorative glyphs,
   * deliberate disabled states, text already composited by ancestor opacity —
   * and the point of that issue was that no site gets to be dim by accident.
   *
   * Not a count. A count would pass if someone deleted one carve-out and added a
   * dilute label somewhere else, which is the same swap the lint ratchet's
   * per-rule totals cannot see either. This checks membership in both
   * directions, so a manifest entry whose site has gone fails as loudly as a
   * site the manifest never named.
   *
   * The deeper check — that each site still *qualifies* for the category it
   * claims — needs the classifier and lives in `npm run theme:text-ramp -- --check`.
   * This test is the cheap always-on half: no parser, no ts-morph, and it runs
   * with the rest of the colour contract.
   *
   * Regenerate with `npm run theme:text-ramp -- --plan` after a deliberate change.
   */
  it("accounts for every surviving text-daintree-text/NN site in the ramp manifest", () => {
    type ManifestEntry = {
      file: string;
      line: number;
      start: number;
      token: string;
      category: string;
      evidence: string;
    };
    const manifest: { occurrences: ManifestEntry[] } = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "scripts/baselines/text-ramp-manifest.json"), "utf8")
    );

    // Every category the manifest is allowed to use. An entry outside this set
    // is not a carve-out, it is a typo that would otherwise pass.
    const NAMED_CARVE_OUTS = new Set([
      "icon-affordance",
      "decorative-glyph",
      "disabled-state",
      "placeholder-variant",
      "opacity-composite",
      "semantic-state-pair",
      "sibling-branch-pair",
      "prior-ruling-40",
      "comment-reference",
      "test-assertion",
    ]);

    const rampToken = /(?<![\w-])(?:[\w@&[\]./-]+:)*!?text-daintree-text\/\d+!?(?![\w/-])/g;
    const inTree = new Map<string, string>();
    const walked = new Set<string>();
    for (const filePath of RENDERER_ROOTS.flatMap(collectSourceFiles)) {
      const relative = path.relative(REPO_ROOT, filePath);
      walked.add(relative);
      const source = fs.readFileSync(filePath, "utf8");
      if (!source.includes("text-daintree-text/")) continue;
      for (const match of source.matchAll(rampToken)) {
        inTree.set(`${relative}:${match.index}`, match[0]);
      }
    }

    // Scope both directions to the files this walk actually visits. The manifest
    // is wider — it also covers `__tests__`, which `collectSourceFiles` skips —
    // and holding it to entries nothing here reads would fail for a reason that
    // has nothing to do with the tree. Comment references stay in: they sit in
    // files that ARE walked, and a text scan cannot tell prose from code.
    const painted = manifest.occurrences.filter((entry) => walked.has(entry.file));

    const problems: string[] = [];
    const named = new Map(painted.map((entry) => [`${entry.file}:${entry.start}`, entry]));

    for (const [key, token] of inTree) {
      const entry = named.get(key);
      if (!entry) problems.push(`${key} ${token} — no manifest entry`);
      else if (entry.token !== token) {
        problems.push(`${key} — manifest says ${entry.token}, source has ${token}`);
      } else if (!NAMED_CARVE_OUTS.has(entry.category)) {
        problems.push(`${key} ${token} — "${entry.category}" is not a named carve-out`);
      } else if (entry.evidence.trim() === "") {
        problems.push(`${key} ${token} — carve-out with no stated reason`);
      }
    }
    for (const [key, entry] of named) {
      if (!inTree.has(key)) problems.push(`${key} ${entry.token} — manifest entry not in the tree`);
    }

    expect(
      problems,
      `Every remaining opacity-ramp site must be a reviewed carve-out, and every ` +
        `carve-out must still be there. Either move these onto a solid text token, ` +
        `or run \`npm run theme:text-ramp -- --plan\` to re-record why they stay dim.`
    ).toEqual([]);
  });

  it("defines --dock-shadow with alpha-pinned relative color (visible on light themes)", () => {
    // Regression for #8156: color-mix multiplied --theme-shadow-color's own
    // alpha (0.12 on light themes) toward transparent, making the dock shadow
    // effectively invisible. Relative color syntax strips the input alpha and
    // pins it at a visible value across all 14 themes.
    expect(indexCss).toMatch(
      /--dock-shadow:\s*0 -2px 12px rgb\(from var\(--theme-shadow-color\) r g b \/ 0\.35\)/
    );
    expect(indexCss).not.toMatch(/--dock-shadow:[^;]*color-mix/);
  });

  it("declares the waiting dock-item state tokens consumed by docked items", () => {
    // Regression for #8156: DockedTerminalItem/DockedTabGroup read these tokens
    // for the waiting-agent highlight, but they were never declared, so the
    // waiting state was visually identical to idle on every theme.
    expect(indexCss).toMatch(
      /--dock-item-bg-waiting:\s*color-mix\(in oklab, var\(--color-activity-waiting\) 10%, transparent\)/
    );
    expect(indexCss).toMatch(
      /--dock-item-border-waiting:\s*rgb\(from var\(--color-activity-waiting\) r g b \/ 0\.3\)/
    );
  });

  it("panel focus chrome consumes the extension vars WITH fallbacks (omission = legacy recipe)", () => {
    // The panel-focus-* / panel-selected-bg extension keys are only safe
    // because every consumer carries the pre-extension recipe as its var()
    // fallback — a theme that authors none of them must render identically.
    // Guard the fallback's presence (not its literal value) at each site.
    // `.terminal-selected-quiet` reads the border key but deliberately owns no
    // box-shadow (see the uncontested-property contract below), so it is held
    // to the border half only.
    for (const selector of [
      ".terminal-selected",
      ".terminal-selected-quiet",
      ".assistant-focused",
      ".terminal-focused",
    ]) {
      // Anchored to line start so the match binds to the top-level rule and
      // never to an indented override of the same selector nested inside one
      // of the media blocks further down the file.
      const block = indexCss.match(
        new RegExp(`^${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{[^}]+\\}`, "m")
      )?.[0];
      expect(block, `${selector} rule exists`).toBeTruthy();
      expect(block, `${selector} themeable border with fallback`).toMatch(
        /var\(\s*--panel-focus-border,\s*color-mix\(/
      );
      if (selector === ".terminal-selected-quiet") continue;
      expect(block, `${selector} themeable shadow with fallback`).toMatch(
        /var\(\s*--panel-focus-shadow,\s*inset /
      );
    }
  });

  it("keeps the lone-pane quiet cue fill-free so it stays lighter than terminal-selected", () => {
    // #11837: the quiet cue exists precisely because the surface-lift fill is
    // what made an always-lit lone pane too heavy in #7544. If a later edit
    // gives it a background it stops being a distinct rung and the revert
    // that motivated this design gets re-litigated.
    const quiet = indexCss.match(/^\.terminal-selected-quiet\s*\{[^}]+\}/m)?.[0];
    expect(quiet, ".terminal-selected-quiet rule exists").toBeTruthy();
    expect(quiet).not.toMatch(/background/);
    // The full-strength sibling is the one that carries the fill — proves the
    // two rungs are actually different rather than both being fill-free.
    expect(indexCss.match(/^\.terminal-selected\s*\{[^}]+\}/m)?.[0]).toMatch(
      /background-color:\s*var\(\s*--panel-selected-bg/
    );
  });

  it("anchors the lone-pane quiet cue on a property no competing pane state claims", () => {
    // #11837, and the reason the cue is not simply a lighter `.terminal-
    // selected`: a lone pane can carry an agent-state border or the dictation
    // lock at the same time, and those are single-class rules that land later
    // in this file — including their `.light` overrides. Whatever property
    // they set, they replace outright. `.terminal-selected` survives that on
    // its surface-lift fill; this cue has none by design, so it must own at
    // least one property none of them touch or it silently becomes invisible
    // exactly when a state is active. Adding a state class that claims that
    // property has to fail here rather than in someone's eyes.
    const COMPETING_STATES = [
      "panel-voice-dictation-locked",
      "panel-state-compiling",
      "panel-state-working",
      "panel-state-waiting",
      "panel-state-hibernated",
    ];

    /**
     * Property names declared by every TOP-LEVEL rule whose selector carries
     * `className`. Scoped to the unnested cascade — which includes the `.light`
     * overrides — because the forced-colors block deliberately converges these
     * classes onto a shared system outline, and the distinguishability that
     * mode needs is a different problem with its own contract below. Nested
     * rules are indented in this file; top-level selectors start at column 0.
     */
    function propertiesSetFor(className: string) {
      const properties = new Set<string>();
      const names = new RegExp(`\\.${className}(?![\\w-])`);
      for (const [, selector, body] of indexCss.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        if (!selector || !body) continue;
        // A rule that also names the cue is a deliberate pairing, not a rival.
        if (selector.includes("terminal-selected-quiet")) continue;
        const declaresAtTopLevel = selector
          .split("\n")
          .some((line) => names.test(line) && !/^\s/.test(line));
        if (!declaresAtTopLevel) continue;
        for (const [, property] of body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)) {
          if (property) properties.add(property);
        }
      }
      return properties;
    }

    const contested = new Set<string>();
    for (const state of COMPETING_STATES) {
      const properties = propertiesSetFor(state);
      // Guards the guard — a renamed state class would otherwise contribute
      // nothing and make the survivor check trivially pass.
      expect(properties.size, `.${state} has styling rules`).toBeGreaterThan(0);
      properties.forEach((property) => contested.add(property));
    }

    const quiet = indexCss.match(/^\.terminal-selected-quiet\s*\{([^}]+)\}/m)?.[1];
    expect(quiet, ".terminal-selected-quiet rule exists").toBeTruthy();
    const quietProperties = [...(quiet ?? "").matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map(
      ([, property]) => property
    );
    const uncontested = quietProperties.filter((property) => !contested.has(property ?? ""));

    expect(
      uncontested,
      `every property of the cue [${quietProperties.join(", ")}] is also set by a pane state`
    ).not.toEqual([]);
  });

  it("keeps the lone-pane quiet cue distinguishable under forced colors", () => {
    // Forced colors collapses the palette to a few system colors and drops
    // box-shadow, so several pane rules converge on the same solid Highlight
    // outline. A lone focused pane that is ALSO locked or waiting would then
    // be pixel-identical to the same pane with the Assistant focused — the
    // #11837 ambiguity, reintroduced in the one mode that can least afford it.
    // Stroke style is the differentiator the UA leaves alone.
    const forcedColors = indexCss
      .match(/@media \(forced-colors: active\)\s*\{[\s\S]*?\n\}/g)
      ?.find((block) => block.includes(".terminal-selected-quiet"));
    expect(forcedColors, "a forced-colors block covers the quiet cue").toBeTruthy();
    const block = forcedColors ?? "";

    const quietOutline = block.match(/\.terminal-selected-quiet\s*\{[^}]*outline:\s*([^;]+);/)?.[1];
    expect(quietOutline, "the cue outlines the pane").toBeTruthy();
    expect(quietOutline).toContain("dashed");

    // Every other pane rule in the block that outlines must differ from it,
    // otherwise whichever lands later wins and the two states converge again.
    const rivals = [...block.matchAll(/(\.[^{}]*)\{([^}]*outline:\s*([^;]+);[^}]*)\}/g)].filter(
      ([, selector]) => selector && !selector.includes("terminal-selected-quiet")
    );
    expect(rivals.length, "other pane rules outline in forced colors").toBeGreaterThan(0);
    for (const [, selector, , outline] of rivals) {
      expect(outline?.trim(), `${selector?.trim()} differs from the focus cue`).not.toBe(
        quietOutline?.trim()
      );
    }

    // Equal specificity, so the cue must also come last to win when a pane is
    // focused AND locked at the same time.
    expect(block.indexOf(".terminal-selected-quiet")).toBeGreaterThan(
      block.indexOf(".panel-voice-dictation-locked")
    );
  });

  it("scales the lone-pane quiet cue with the increased-contrast border", () => {
    const increasedContrast = indexCss
      .match(/@media \(prefers-contrast: more\)\s*\{[\s\S]*?\n\}/g)
      ?.find((block) => block.includes(".terminal-selected-quiet"));
    expect(increasedContrast, "a prefers-contrast block covers the quiet cue").toBeTruthy();
    // Participation in the border-width rule, not mere presence in the block —
    // the selector could otherwise sit in an unrelated rule and still pass.
    expect(increasedContrast).toMatch(/\.terminal-selected-quiet[^{}]*\{[^}]*border-width:\s*2px/);
    // The cue sits inside the border, so widening one without the other paints
    // the hairline on top of the border instead of within it.
    expect(increasedContrast).toMatch(/\.terminal-selected-quiet\s*\{[^}]*outline-offset:\s*-2px/);
  });

  it("wires :root --background to --theme-surface-canvas", () => {
    expect(indexCss).toMatch(/--background:\s*var\(--theme-surface-canvas\)/);
  });

  it("wires :root --primary-foreground to --theme-accent-foreground", () => {
    expect(indexCss).toMatch(/--primary-foreground:\s*var\(--theme-accent-foreground\)/);
  });

  it(".dark block contains only --chart-* declarations", () => {
    const darkBlock = indexCss.match(/\.dark\s*\{[^}]+\}/s)?.[0] ?? "";
    const declarations = darkBlock.match(/--[\w-]+:/g) ?? [];
    for (const decl of declarations) {
      expect(decl, `Unexpected non-chart declaration in .dark: ${decl}`).toMatch(/^--chart-\d+:$/);
    }
    expect(declarations.length).toBe(5);
  });

  it("suppresses Tailwind default palette with --color-*: initial", () => {
    const themeBlock = indexCss.match(/@theme\s+inline\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(themeBlock).toMatch(/--color-\*:\s*initial/);
  });

  it("exports structural category color variants (-subtle, -text, -border)", () => {
    const categories = [
      "blue",
      "purple",
      "cyan",
      "green",
      "amber",
      "orange",
      "teal",
      "indigo",
      "rose",
      "pink",
      "violet",
      "slate",
    ];
    const variants = ["subtle", "text", "border"];
    for (const cat of categories) {
      for (const variant of variants) {
        expect(
          exportedColorVars.has(`category-${cat}-${variant}`),
          `Missing --color-category-${cat}-${variant}`
        ).toBe(true);
      }
    }
  });

  it("does not import github-dark.min.css", () => {
    expect(indexCss).not.toContain("github-dark.min.css");
  });

  it("contains no rgba(0,0,0) shadow values", () => {
    expect(indexCss).not.toMatch(/rgba\(0,\s*0,\s*0/);
  });

  // A --color-* declared twice in one @theme inline block silently resolves to the
  // last one; Tailwind emits no warning. That is how --color-accent-foreground came
  // to resolve to body text instead of the contrast-validated accent foreground
  // (#11115), and how --color-accent-primary regressed before it (#2687). Uniqueness
  // is the invariant that catches the whole class.
  it("declares every --color-* exactly once across @theme inline", () => {
    // Count across EVERY @theme inline block, not just the first — a second block
    // would reintroduce cross-block shadowing that a single-block scan can't see.
    const blocks = [...indexCss.matchAll(/@theme\s+inline\s*\{[\s\S]*?\n\}/g)].map((m) => m[0]);
    expect(blocks.length, "could not locate any @theme inline block").toBeGreaterThan(0);

    const counts = new Map<string, number>();
    for (const block of blocks) {
      for (const [, name] of block.matchAll(/^\s*(--color-[\w-]+)\s*:/gm)) {
        if (name === undefined) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    expect(counts.size, "no --color-* declarations found — regex is stale").toBeGreaterThan(0);

    const duplicated = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name} (x${count})`);
    expect(duplicated, "duplicate --color-* declarations silently shadow each other").toEqual([]);
  });

  it("sets color-scheme: normal on webview elements to prevent dark-mode inheritance", () => {
    expect(indexCss).toMatch(/webview\s*\{[^}]*color-scheme:\s*normal/s);
  });
});
