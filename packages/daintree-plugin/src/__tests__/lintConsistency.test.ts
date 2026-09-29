import { afterEach, describe, expect, it } from "vitest";
import { cleanupPlugins, lintFor } from "./lintFixtures.js";

afterEach(cleanupPlugins);

const view = (jsx: string, head = "") => ({
  "src/panel.tsx": `import { cn } from "./cn";\n${head}export default function Panel({ on }) {\n  return (\n    ${jsx}\n  );\n}\n`,
});

/** Rule id → [a view that trips it, a view that does not]. */
const CLASS_CASES: Record<string, [string, string]> = {
  "stock-palette-colour": [
    `<div className="p-2 bg-red-500 text-white" />`,
    `<div className="p-2 bg-surface-panel text-text-primary bg-transparent" />`,
  ],
  "dark-variant": [
    `<div className={cn("bg-surface-panel", on && "dark:bg-surface-canvas")} />`,
    `<div className="bg-surface-panel hover:bg-overlay-soft" />`,
  ],
  "legacy-daintree-utility": [
    `<div className="text-daintree-text" />`,
    `<div className="text-text-primary" />`,
  ],
  "raw-shadow": [
    `<div className="shadow-lg" />`,
    `<div className="shadow-[var(--theme-shadow-floating)] shadow-none" />`,
  ],
  "arbitrary-text-size": [
    `<div className="text-[11px]" />`,
    `<div className="text-xs text-[var(--x)] text-[#abc]" />`,
  ],
  "text-colour-slash-alpha": [
    `<div className="text-text-secondary/70" />`,
    `<div className="text-sm/6 bg-overlay-soft/50 text-text-muted" />`,
  ],
  "raw-radius": [
    `<div className="rounded rounded-[3px]" />`,
    `<div className="rounded-md rounded-full rounded-[var(--radius-md)]" />`,
  ],
  "unpaired-outline-suppression": [
    `<div className="outline-hidden" />`,
    `<div className="outline-hidden focus-visible:ring-2 focus-visible:ring-border-strong" />`,
  ],
  "hand-rolled-spinner": [`<div className="animate-spin" />`, `<div className="animate-pulse" />`],
  "hand-rolled-badge": [
    `<span className="bg-status-error/10 text-status-error" />`,
    `<span className="bg-status-error text-text-inverse" />`,
  ],
};

describe("class-string rules", () => {
  for (const [ruleId, [bad, good]] of Object.entries(CLASS_CASES)) {
    it(`${ruleId}: flags the violation and passes the idiom`, async () => {
      const flagged = await lintFor(ruleId, view(bad));
      expect(flagged.length).toBeGreaterThan(0);
      expect(flagged[0]).toMatchObject({ file: "src/panel.tsx", line: 4 });
      expect(await lintFor(ruleId, view(good))).toEqual([]);
    });
  }

  it("reads class constants and cn() calls outside JSX, but not arbitrary strings", async () => {
    const flagged = await lintFor("stock-palette-colour", {
      "src/styles.ts": `export const rowClasses = "px-2 bg-blue-600";\nexport const x = cn("text-red-500");\n`,
    });
    expect(flagged.map((f) => f.line)).toEqual([1, 2]);
    const clean = await lintFor("stock-palette-colour", {
      "src/copy.ts": `export const label = "bg-red-500 is not a class here";\n`,
    });
    expect(clean).toEqual([]);
  });

  it("skips fragments that abut a template interpolation", async () => {
    const findings = await lintFor(
      "raw-radius",
      view("<div className={`rounded${on ? '-md' : '-lg'}`} />")
    );
    expect(findings).toEqual([]);
  });

  it("flags outline-none even when a focus ring is present", async () => {
    const findings = await lintFor(
      "unpaired-outline-suppression",
      view(`<div className="outline-none focus-visible:ring-2" />`)
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toMatch(/forced-colours/);
  });
});

describe("apply-directive", () => {
  it("flags @apply in a stylesheet and ignores it in a comment", async () => {
    expect(
      await lintFor("apply-directive", { "src/panel.css": ".x { @apply p-4; }\n" })
    ).toHaveLength(1);
    expect(
      await lintFor("apply-directive", {
        "src/panel.css": "/* no @apply here */\n.x { padding: 1rem; }\n",
      })
    ).toEqual([]);
  });
});

describe("element rules", () => {
  const ELEMENT_CASES: Record<string, [string, string]> = {
    "raw-button": [`<button onClick={on}>Go</button>`, `<Button onClick={on}>Go</Button>`],
    "raw-form-control": [
      `<div><input type="checkbox" /><select /><textarea /></div>`,
      `<div><Checkbox /><input type="hidden" name="id" /><input type="file" /></div>`,
    ],
    "native-title-tooltip": [
      `<div><span title="Open">x</span></div>`,
      `<div><Tooltip content="Open"><span aria-label="Open">x</span></Tooltip><Button title="Go" /></div>`,
    ],
    "inline-svg-icon": [
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14" /></svg>`,
      `<svg viewBox="0 0 100 20"><rect width="50" height="20" /></svg>`,
    ],
  };

  for (const [ruleId, [bad, good]] of Object.entries(ELEMENT_CASES)) {
    it(`${ruleId}: flags the raw element and passes the kit component`, async () => {
      expect((await lintFor(ruleId, view(bad))).length).toBeGreaterThan(0);
      expect(await lintFor(ruleId, view(good))).toEqual([]);
    });
  }

  it("reads the top-level prop, not a nested one of the same name", async () => {
    const findings = await lintFor(
      "raw-form-control",
      view(`<input data={{ type: "hidden" }} type="text" />`)
    );
    expect(findings).toHaveLength(1);
  });

  it("suggests the kit component matching the input type", async () => {
    const findings = await lintFor(
      "raw-form-control",
      view(`<div><input type="checkbox" /><input /></div>`)
    );
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining("`Checkbox`"),
      expect.stringContaining("`Input`"),
    ]);
  });

  it("suggests Input only for the types the kit Input renders", async () => {
    const findings = await lintFor(
      "raw-form-control",
      view(
        `<div><input type="email" /><input type="Number" /><input type="submit" /><input type="date" /><input type="range" /><input type="color" /><input type="time" /><input type={kind} /></div>`
      )
    );
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('type="email">; prefer `Input`'),
      expect.stringContaining('type="number">; prefer `Input`'),
      expect.stringContaining("`Button`"),
    ]);
  });

  it("does not suggest the single-choice kit Select for a multi-select", async () => {
    expect(await lintFor("raw-form-control", view(`<select multiple />`))).toEqual([]);
    expect(await lintFor("raw-form-control", view(`<select />`))).toHaveLength(1);
  });

  it("flags title= on intrinsic elements only, not on kit components", async () => {
    const findings = await lintFor(
      "native-title-tooltip",
      view(`<div><Button title="Go" /><IconButton title="x" /><a title="Docs" href="#" /></div>`)
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("<a>");
    expect(findings[0]!.hint).toContain("tooltip");
  });

  it("reads a zero-build view's createElement calls the same way", async () => {
    const findings = await lintFor("raw-button", {
      "dist/panel.js": `import { createElement } from "react";\nexport default function P() {\n  return createElement("button", { title: "x" }, "Go");\n}\n`,
      "dist/index.mjs": "export async function activate() {}\n",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "dist/panel.js", line: 3 });
  });

  it("does not read element rules in worker code", async () => {
    const findings = await lintFor("raw-button", {
      "src/index.ts": `export async function activate() { const tag = createElement("button", {}); }\n`,
    });
    expect(findings).toEqual([]);
  });
});

describe("lucide-react-import", () => {
  it("flags a view importing lucide-react and passes one importing the kit", async () => {
    expect(
      await lintFor("lucide-react-import", view(`<X />`, `import { X } from "lucide-react";\n`))
    ).toHaveLength(1);
    expect(
      await lintFor(
        "lucide-react-import",
        view(`<Icon />`, `import { Icon } from "@daintreehq/plugin-ui";\n`)
      )
    ).toEqual([]);
  });
});
