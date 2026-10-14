import { afterEach, describe, expect, it } from "vitest";
import { formatLintReport, runLint } from "../commands/lint.js";
import { lintPlugin, LINT_RULES, STYLE_REPORT_RULE_ID } from "../lib/lint/index.js";
import { scanSource } from "../lib/lint/source.js";
import { cleanupPlugins, lintFor, VIEW_MANIFEST, writePlugin } from "./lintFixtures.js";

afterEach(cleanupPlugins);

describe("scanSource", () => {
  it("masks comments, strings and regex bodies without desynchronising", () => {
    const src = `const a = /"/g; // it's\nconst b = "x{"; const c = \`t\${ {a:1}.a }u\`;\nsetInterval(f);`;
    const { masked, strings } = scanSource(src);
    expect(masked).toContain("setInterval(f)");
    expect(masked).not.toContain("it's");
    expect(masked.length).toBe(src.length);
    expect(strings.map((s) => s.text)).toEqual(["x{", "t", "u"]);
  });

  it("reads a slash after a postfix operator as division", () => {
    const { masked } = scanSource("n++ / d; setInterval(f); x = a / b;");
    expect(masked).toContain("setInterval(f)");
  });
});

describe("lintPlugin", () => {
  it("has a unique id for every rule", () => {
    const ids = LINT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("skips node_modules, build output, tests and config when a build step exists", async () => {
    const dir = await writePlugin({
      "vite.config.ts": "export default { setInterval() {} };\n",
      "src/panel.tsx": 'export default function P() { return <div className="p-2" />; }\n',
      "src/__tests__/panel.test.tsx": "setInterval(() => {}, 1);\n",
      "node_modules/x/index.js": "setInterval(() => {}, 1);\n",
      "dist/panel.js": "setInterval(() => {}, 1);\n",
    });
    const result = await lintPlugin({ dir, styleReport: false });
    expect(result.files).toEqual(["dist/panel.js", "src/panel.tsx"]);
    expect(result.findings).toEqual([]);
  });

  it("classifies by the manifest, then content, then path", async () => {
    const dir = await writePlugin({
      "dist/index.mjs": "setInterval(() => {}, 1);\nexport async function activate() {}\n",
      "dist/panel.js": "setInterval(() => {}, 1);\nexport default function P() {}\n",
      "renderer/poll.ts": "setInterval(() => {}, 1);\n",
      "lib/util.ts": "setInterval(() => {}, 1);\n",
    });
    const result = await lintPlugin({ dir, styleReport: false });
    expect(result.findings.map((f) => f.file)).toEqual(["dist/panel.js", "renderer/poll.ts"]);
  });

  it("treats manifest entries as build output wherever they live when there is a build step", async () => {
    const dir = await writePlugin(
      {
        "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
        "src/panel.tsx": "export default function P() { return null; }\n",
        "lib/panel.js": "setInterval(() => {}, 1);\n/** @license React */\n",
        "lib/index.mjs": "setInterval(() => {}, 1);\n",
      },
      {
        ...VIEW_MANIFEST,
        main: "lib/index.mjs",
        contributes: { experimental_views: [{ id: "main", componentPath: "lib/panel.js" }] },
      }
    );
    const result = await lintPlugin({ dir, styleReport: false });
    expect(result.files).toEqual(["lib/panel.js", "src/panel.tsx"]);
    expect(result.findings.map((f) => `${f.file}:${f.ruleId}`)).toEqual([
      "lib/panel.js:bundled-react",
    ]);
  });

  it("refuses a directory that does not exist", async () => {
    await expect(lintPlugin({ dir: "/definitely/not/here" })).rejects.toThrow(/not a directory/);
  });

  it("lints a directory with no manifest and says so", async () => {
    const dir = await writePlugin({ "src/panel.tsx": "setInterval(() => {}, 1);\n" }, null);
    const result = await lintPlugin({ dir, styleReport: false });
    expect(result.findings).toHaveLength(1);
    expect(result.notes[0]).toMatch(/No readable plugin.json/);
  });

  it("measures the 2 MB bundle cut-off in bytes, not characters", async () => {
    // 1.1M characters either way; only the non-ASCII one is over 2 MiB on disk.
    const count = 1_100_000;
    const dir = await writePlugin({
      "src/wide.ts": `// ${"é".repeat(count)}\nexport const a = 1;\n`,
      "src/narrow.ts": `// ${"e".repeat(count)}\nexport const b = 1;\n`,
    });
    const result = await lintPlugin({ dir, styleReport: false });
    expect(result.files).toEqual(["src/narrow.ts"]);
    expect(result.notes).toEqual([
      expect.stringMatching(/^Skipped src\/wide\.ts: larger than 2 MB/),
    ]);
  });

  it("reports the author's line in TSX, not esbuild's", async () => {
    const dir = await writePlugin({
      "src/panel.tsx": `import { useEffect } from "react";
type Props = {
  id: string;
};

export default function Panel(props: Props) {
  useEffect(() => {
    const t = setInterval(() => {}, 1000);
    return () => clearInterval(t);
  }, []);
  return <p>Don't</p>;
}
`,
    });
    const result = await lintPlugin({ dir, styleReport: false });
    expect(result.findings.map((f) => f.line)).toEqual([8]);
  });
});

describe("style report", () => {
  it("lists classes that compile to nothing against the design contract, once per file", async () => {
    const dir = await writePlugin({
      "src/panel.tsx": `export default function P({ open }) {
  return (
    <div className="p-4 bg-surface-panel text-text-primary">
      <span className={open ? "text-foo w-[327px]" : "hover:p-4 foo:p-4"} />
      <span className="bg-red-500" />
    </div>
  );
}
`,
    });
    const result = await lintPlugin({ dir });
    const report = result.findings.filter((f) => f.ruleId === STYLE_REPORT_RULE_ID);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ file: "src/panel.tsx", line: 4, severity: "warn" });
    expect(report[0]!.message).toBe(
      "classes that compile to nothing (Tailwind generates no CSS for them): text-foo, foo:p-4"
    );
    // The stock colour is reported by its own rule, which names the fix.
    expect(result.findings.some((f) => f.ruleId === "stock-palette-colour")).toBe(true);
  });

  it("leaves out classes the plugin's own stylesheet defines", async () => {
    const dir = await writePlugin({
      "src/panel.css": ".text-foo { color: var(--theme-text-primary); }\n",
      "src/panel.tsx": 'export default function P() { return <div className="text-foo" />; }\n',
    });
    const result = await lintPlugin({ dir });
    expect(result.findings).toEqual([]);
  });

  it("stays quiet for classes that generate CSS and strings that are not utilities", async () => {
    const dir = await writePlugin({
      "src/panel.tsx": `export default function P({ open }) {
  return <div className={open === "open" ? "flex gap-2 animate-in fade-in" : "hidden"} />;
}
`,
    });
    const result = await lintPlugin({ dir });
    expect(result.findings).toEqual([]);
  });
});

describe("runLint", () => {
  const PLUGIN = {
    "src/panel.tsx": `export default function P() {
  setInterval(() => {}, 1);
  return <div className="bg-red-500" />;
}
`,
  };

  it("fails on errors, and on warnings only under --strict", async () => {
    const warnOnly = await writePlugin({ "src/panel.tsx": "setInterval(() => {}, 1);\n" });
    expect((await runLint({ dir: warnOnly })).ok).toBe(true);
    expect((await runLint({ dir: warnOnly, strict: true })).ok).toBe(false);
    expect((await runLint({ dir: await writePlugin(PLUGIN) })).ok).toBe(false);
  });

  it("groups human output by file with rule ids and a fix line", async () => {
    const result = await runLint({ dir: await writePlugin(PLUGIN) });
    const lines = formatLintReport(result);
    expect(lines[0]).toBe("src/panel.tsx");
    expect(lines.some((line) => /\b2\s+⚠\s+interval-polling-in-view\b/.test(line))).toBe(true);
    expect(lines.some((line) => /\b3\s+✗\s+stock-palette-colour\b/.test(line))).toBe(true);
    expect(lines.filter((line) => line.trim().startsWith("fix: "))).toHaveLength(2);
    expect(lines[lines.length - 1]).toBe("✗ 1 error, 1 warning in 1 file");
  });

  it("says so when there is nothing to report", async () => {
    const result = await runLint({ dir: await writePlugin({ "src/panel.tsx": "export {};\n" }) });
    expect(formatLintReport(result)).toEqual(["✓ No lint findings in 1 file"]);
  });
});

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
    `<div className="shadow-floating shadow-[var(--theme-shadow-floating)] shadow-none" />`,
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
  "viewport-breakpoint": [
    `<div className={cn("grid grid-cols-1", on && "md:grid-cols-3 max-sm:hidden")} />`,
    `<div className="@container"><div className="grid-cols-1 @md:grid-cols-3 hover:bg-overlay-soft" /></div>`,
  ],
  "hand-rolled-drawer": [
    `<aside className={cn("absolute inset-y-0 right-0 w-80", !open && "translate-x-full")} />`,
    `<span className="translate-x-1 -translate-y-1/2" />`,
  ],
  "hand-rolled-forge-state": [
    `<span className={cn("h-4 w-4 border-l-pr-closed", merged ? "bg-pr-merged/10" : "text-pr-open")} />`,
    `<span className="text-status-success" />`,
  ],
};

describe("hand-rolled-forge-state", () => {
  it("sees the ink through opacity modifiers and border sides", async () => {
    for (const cls of [
      "bg-pr-open/10",
      "border-l-pr-closed",
      "fill-pr-merged/50",
      "hover:text-pr-draft",
    ]) {
      const flagged = await lintFor("hand-rolled-forge-state", view(`<span className="${cls}" />`));
      expect(flagged.length, cls).toBe(1);
    }
    expect(
      await lintFor("hand-rolled-forge-state", view(`<span className="text-pr-opening" />`))
    ).toEqual([]);
  });
});

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

  it("points a password field at SecretInput", async () => {
    const findings = await lintFor("raw-form-control", view(`<input type="password" />`));
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('type="password">; prefer `SecretInput`'),
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
      expect.stringContaining('type="date">; prefer `DatePicker`'),
      expect.stringContaining('type="range">; prefer `Slider`'),
      expect.stringContaining('type="color">; prefer `ColorPicker`'),
      expect.stringContaining('type="time">; prefer `TimePicker`'),
    ]);
  });

  it("never reads a capitalised kit component as the intrinsic of the same name", async () => {
    const kit = `import { Input, Checkbox, Select, Textarea, Button, Icon } from "@daintreehq/plugin-ui";\nimport * as UI from "@daintreehq/plugin-ui";\n`;
    const jsx = `<div><Input type="date" /><Input type="checkbox" /><Input /><UI.Input type="text" /><Select /><Textarea /><Checkbox /><Button title="Go" /><Icon viewBox="0 0 24 24" /></div>`;
    for (const ruleId of [
      "raw-form-control",
      "raw-button",
      "native-title-tooltip",
      "inline-svg-icon",
    ]) {
      expect(await lintFor(ruleId, view(jsx, kit)), ruleId).toEqual([]);
    }
    const intrinsic = await lintFor(
      "raw-form-control",
      view(`<div><Input type="date" /><input type="text" /></div>`, kit)
    );
    expect(intrinsic.map((f) => f.message)).toEqual([expect.stringContaining('type="text"')]);
  });

  it('reads createElement(Input, …) as the kit component and createElement("input", …) as raw', async () => {
    const findings = await lintFor("raw-form-control", {
      "dist/panel.js": `import { createElement } from "react";\nimport { Input } from "@daintreehq/plugin-ui";\nexport default function P() {\n  return [createElement(Input, { type: "date" }), createElement(Input, { type: "text" }), createElement("input", { type: "email" })];\n}\n`,
      "dist/index.mjs": "export async function activate() {}\n",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('type="email"');
  });

  it("suggests MultiSelect, not the single-choice Select, for a multi-select", async () => {
    const multi = await lintFor("raw-form-control", view(`<select multiple />`));
    expect(multi.map((f) => f.message)).toEqual([expect.stringContaining("`MultiSelect`")]);
    const single = await lintFor("raw-form-control", view(`<select />`));
    expect(single.map((f) => f.message)).toEqual([expect.stringContaining("`Select`")]);
  });

  it("suggests RadioGroup for a raw radio", async () => {
    const findings = await lintFor("raw-form-control", view(`<input type="radio" />`));
    expect(findings.map((f) => f.message)).toEqual([expect.stringContaining("`RadioGroup`")]);
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

describe("inline-style-colour", () => {
  it("flags literal colours in colour-bearing style properties", async () => {
    const findings = await lintFor(
      "inline-style-colour",
      view(
        `<div style={{ color: "#fff", backgroundColor: on ? "rgb(12, 34, 56)" : "var(--theme-surface-panel)", border: "1px solid red", boxShadow: "0 1px 2px hsla(0, 0%, 0%, 0.4)", width: 4, fontFamily: "Tan Sans" }} />`
      )
    );
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('style color: "#fff"'),
      expect.stringContaining('style backgroundColor: "rgb(12, 34, 56)"'),
      expect.stringContaining('style border: "red"'),
      expect.stringContaining('style boxShadow: "hsla(0, 0%, 0%, 0.4)"'),
    ]);
    expect(findings[0]).toMatchObject({ file: "src/panel.tsx", line: 4, severity: "warn" });
    expect(findings[0]!.hint).toContain("var(--theme-");
  });

  it("flags literal fill, stroke and stop colours on SVG elements", async () => {
    const findings = await lintFor(
      "inline-style-colour",
      view(
        `<svg viewBox="0 0 100 40"><linearGradient id="g"><stop stopColor="oklch(0.7 0.1 200)" /><stop stop-color="white" /></linearGradient><path fill="#0af" stroke="hsl(210 50% 40%)" /></svg>`
      )
    );
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('stopColor="oklch(0.7 0.1 200)" on <stop>'),
      expect.stringContaining('stop-color="white" on <stop>'),
      expect.stringContaining('fill="#0af" on <path>'),
      expect.stringContaining('stroke="hsl(210 50% 40%)" on <path>'),
    ]);
  });

  it("passes a chart painted with currentColor, tokens and gradient references", async () => {
    const chart = `<svg viewBox="0 0 100 40" className="text-category-blue" style={{ color: "var(--theme-category-blue)", background: "transparent" }}>
      <defs><linearGradient id="abc"><stop offset="0" stopColor="var(--theme-category-blue)" /><stop offset="1" stopColor="currentColor" stopOpacity={0} /></linearGradient></defs>
      <path d="M0 40 L50 10 L100 20" fill="url(#abc)" stroke="currentColor" />
      <rect className="fill-surface-panel-elevated stroke-border-default" fill="none" stroke="var(--theme-border-default, #ccc)" style={{ fill: on ? "var(--theme-accent-primary)" : "currentColor", borderColor: "inherit" }} />
      <mask id="m"><rect width="100" height="40" fill="white" /><circle r="4" fill="#000" /></mask>
    </svg>`;
    expect(await lintFor("inline-style-colour", view(chart))).toEqual([]);
  });

  it("reads computed keys and inline spreads in a style object", async () => {
    const findings = await lintFor(
      "inline-style-colour",
      view(`<div style={{ ["color"]: "#fff", ...{ borderColor: "navy" } }} />`)
    );
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('style color: "#fff"'),
      expect.stringContaining('style borderColor: "navy"'),
    ]);
  });

  it("ignores strings that select a value, image paths, and anything painted inside a mask", async () => {
    const clean = `<div>
      <div style={{ color: kind === "red" ? "var(--theme-status-danger)" : "currentColor", borderColor: palette["red"], outlineColor: on ? "var(--theme-border-strong)" : undefined }} />
      <div style={{ backgroundImage: 'image-set("/red.png" 1x, "/blue.png" 2x)' }} />
      <div style={{ backgroundImage: \`url(/images/\${name}/red.png)\` }} />
      <svg viewBox="0 0 10 10"><mask id="m"><rect style={{ fill: "white", stroke: "#000" }} /></mask></svg>
    </div>`;
    expect(await lintFor("inline-style-colour", view(clean))).toEqual([]);
  });

  it("reads createElement views, and leaves worker code and kit components alone", async () => {
    const flagged = await lintFor("inline-style-colour", {
      "dist/panel.js": `import { createElement as h } from "react";\nexport default function P() {\n  return h("circle", { r: 4, fill: "rebeccapurple", style: { stroke: "#123456" } });\n}\n`,
      "dist/index.mjs": "export async function activate() {}\n",
    });
    expect(flagged.map((f) => f.line)).toEqual([3, 3]);
    expect(
      await lintFor("inline-style-colour", {
        "src/index.ts": `export const palette = { fill: "#fff" };\nexport async function activate() {}\n`,
      })
    ).toEqual([]);
    expect(
      await lintFor(
        "inline-style-colour",
        view(
          `<Sparkline fill="#0af" stroke="red" />`,
          `import { Sparkline } from "@daintreehq/plugin-ui";\n`
        )
      )
    ).toEqual([]);
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

describe("editor-library-import", () => {
  it("flags a view bundling CodeMirror or a diff library and passes one using the kit", async () => {
    for (const specifier of [
      "@codemirror/view",
      "@codemirror/lang-json",
      "codemirror",
      "@uiw/react-codemirror",
      "react-diff-view",
      "diff2html/lib/ui/js/diff2html-ui",
    ]) {
      expect(
        await lintFor("editor-library-import", view(`<X />`, `import { X } from "${specifier}";\n`))
      ).toHaveLength(1);
    }
    expect(
      await lintFor(
        "editor-library-import",
        view(`<X />`, `const cm = await import("@codemirror/state");\n`)
      )
    ).toHaveLength(1);
    expect(
      await lintFor(
        "editor-library-import",
        view(`<CodeEditor />`, `import { CodeEditor, DiffView } from "@daintreehq/plugin-ui";\n`)
      )
    ).toEqual([]);
  });

  it("ignores a similar name that is not the library", async () => {
    expect(
      await lintFor(
        "editor-library-import",
        view(`<X />`, `import { X } from "./codemirror-notes";\n// from "@codemirror/view"\n`)
      )
    ).toEqual([]);
  });
});

describe("data-view-library-import", () => {
  it("flags a view bundling a grid, tree or JSON viewer and passes one using the kit", async () => {
    for (const specifier of [
      "@tanstack/react-table",
      "ag-grid-react",
      "react-arborist",
      "react-json-view",
      "@uiw/react-json-view/dark",
      "react-inspector",
    ]) {
      expect(
        await lintFor(
          "data-view-library-import",
          view(`<X />`, `import { X } from "${specifier}";\n`)
        )
      ).toHaveLength(1);
    }
    expect(
      await lintFor(
        "data-view-library-import",
        view(
          `<TreeView />`,
          `import { DataTable, ObjectInspector, TreeView } from "@daintreehq/plugin-ui";\n`
        )
      )
    ).toEqual([]);
    expect(
      await lintFor(
        "data-view-library-import",
        view(`<X />`, `import { X } from "./react-table-notes";\n`)
      )
    ).toEqual([]);
    expect(
      await lintFor(
        "data-view-library-import",
        view(`<X />`, `import type { ColumnDef } from "@tanstack/react-table";\n`)
      )
    ).toEqual([]);
    expect(
      await lintFor(
        "data-view-library-import",
        view(`<X />`, `const grid = await import("ag-grid-community");\n`)
      )
    ).toHaveLength(1);
  });
});

describe("ansi-library-import", () => {
  it("flags a view bundling an ANSI-to-HTML library and passes one using the kit", async () => {
    for (const specifier of ["anser", "ansi_up", "ansi-to-html", "ansi-to-react", "fancy-ansi"]) {
      expect(
        await lintFor("ansi-library-import", view(`<X />`, `import X from "${specifier}";\n`))
      ).toHaveLength(1);
    }
    expect(
      await lintFor(
        "ansi-library-import",
        view(`<TerminalOutput />`, `import { TerminalOutput } from "@daintreehq/plugin-ui";\n`)
      )
    ).toEqual([]);
    expect(
      await lintFor("ansi-library-import", view(`<X />`, `import { X } from "./ansi-notes";\n`))
    ).toEqual([]);
  });
});

describe("dnd-library-import", () => {
  it("flags a view importing a drag-and-drop library and passes one using the kit", async () => {
    for (const specifier of [
      "@dnd-kit/core",
      "react-beautiful-dnd",
      "@hello-pangea/dnd",
      "sortablejs",
      "sortablejs/modular/sortable.core.esm.js",
    ]) {
      expect(
        await lintFor("dnd-library-import", view(`<X />`, `import { X } from "${specifier}";\n`))
      ).toHaveLength(1);
    }
    for (const statement of [`import "sortablejs";`, `const dnd = await import("react-dnd");`]) {
      expect(await lintFor("dnd-library-import", view(`<X />`, `${statement}\n`))).toHaveLength(1);
    }
    expect(
      await lintFor("dnd-library-import", view(`<X />`, `import { X } from "sortable-table";\n`))
    ).toEqual([]);
    expect(
      await lintFor(
        "dnd-library-import",
        view(`<SortableList />`, `import { SortableList } from "@daintreehq/plugin-ui";\n`)
      )
    ).toEqual([]);
  });
});

describe("hand-rolled-context-drag", () => {
  it("flags the agent-context drag written by hand and passes the kit's ContextDragSource", async () => {
    expect(
      await lintFor(
        "hand-rolled-context-drag",
        view(
          `<div draggable onDragStart={(e) => e.dataTransfer.setData("application/x-daintree-agent-context", json)} />`
        )
      )
    ).toHaveLength(1);
    expect(
      await lintFor(
        "hand-rolled-context-drag",
        view(
          `<div draggable onDragStart={(e) => setAgentContextDragData(e.dataTransfer, payload)} />`,
          `import { setAgentContextDragData } from "@daintreehq/plugin-sdk";\n`
        )
      )
    ).toHaveLength(1);
    expect(
      await lintFor(
        "hand-rolled-context-drag",
        view(
          `<div onDrop={(e) => read(e.dataTransfer.getData("application/x-daintree-agent-context"))} />`
        )
      )
    ).toEqual([]);
    expect(
      await lintFor(
        "hand-rolled-context-drag",
        view(
          `<ContextDragSource text={body} />`,
          `import { ContextDragSource } from "@daintreehq/plugin-ui";\n`
        )
      )
    ).toEqual([]);
  });
});

describe("raw-portal", () => {
  it("flags createPortal in a view and passes the kit's Portal", async () => {
    const flagged = await lintFor(
      "raw-portal",
      view(
        `<div>{createPortal(<span />, document.body)}</div>`,
        `import { createPortal } from "react-dom";\n`
      )
    );
    expect(flagged).toHaveLength(1);
    expect(
      await lintFor(
        "raw-portal",
        view(`<Portal><div /></Portal>`, `import { Portal } from "@daintreehq/plugin-ui";\n`)
      )
    ).toEqual([]);
  });

  it("follows a namespace or an aliased import", async () => {
    expect(
      await lintFor(
        "raw-portal",
        view(
          `<div>{ReactDOM.createPortal(<span />, document.body)}</div>`,
          `import * as ReactDOM from "react-dom";\n`
        )
      )
    ).toHaveLength(1);
    expect(
      await lintFor(
        "raw-portal",
        view(
          `<div>{portal(<span />, document.body)}</div>`,
          `import { createPortal as portal } from "react-dom";\n`
        )
      )
    ).toHaveLength(1);
  });

  it("ignores an unrelated createPortal where react-dom is not imported", async () => {
    expect(await lintFor("raw-portal", view(`<div>{layers.createPortal("toast")}</div>`))).toEqual(
      []
    );
  });

  it("ignores the name inside a string or comment", async () => {
    expect(
      await lintFor(
        "raw-portal",
        view(
          `<p>{"createPortal(x)"}</p>`,
          `import { flushSync } from "react-dom";\n// createPortal(x)\n`
        )
      )
    ).toEqual([]);
  });
});

describe("self-container-query", () => {
  it("flags a container-query variant on the element that declares the container", async () => {
    const flagged = await lintFor(
      "self-container-query",
      view(`<div className="grid grid-cols-2 @container @md:grid-cols-4" />`)
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ file: "src/panel.tsx", line: 4 });
    expect(flagged[0]!.message).toMatch(/@md:grid-cols-4/);
  });

  it("flags a named container queried by its own name, and range variants", async () => {
    const flagged = await lintFor(
      "self-container-query",
      view(
        `<div className={cn("@container/card @max-md/card:hidden @min-[400px]:flex", on && "p-2")} />`
      )
    );
    expect(flagged).toHaveLength(2);
  });

  it("accepts the container on an ancestor, and a variant naming another container", async () => {
    const clean = await lintFor(
      "self-container-query",
      view(
        `<div className="@container"><div className="grid-cols-2 @md:grid-cols-4" /><div className="@container/inner @lg/outer:p-4" /></div>`
      )
    );
    expect(clean).toEqual([]);
  });

  it("does not pair a container and a child variant kept in one styles object", async () => {
    const clean = await lintFor("self-container-query", {
      "src/styles.ts": `export const cardStyles = { root: "@container p-2", grid: "grid-cols-2 @md:grid-cols-4" };\n`,
    });
    expect(clean).toEqual([]);
  });
});

describe("viewport-breakpoint", () => {
  it("flags each viewport variant, stacked or arbitrary, and nothing container-scoped", async () => {
    const flagged = await lintFor(
      "viewport-breakpoint",
      view(
        `<div className="md:grid-cols-3 max-sm:hidden hover:lg:p-4 min-[600px]:flex max-[900px]:block @md:grid-cols-2 supports-[display:grid]:grid data-[open]:flex" />`
      )
    );
    expect(flagged.map((finding) => /"([^"]+)"/.exec(finding.message)?.[1])).toEqual([
      "md:grid-cols-3",
      "max-sm:hidden",
      "hover:lg:p-4",
      "min-[600px]:flex",
      "max-[900px]:block",
    ]);
  });
});

describe("native-dialog-in-view", () => {
  it("flags window.confirm, alert and prompt, qualified or bare", async () => {
    const flagged = await lintFor("native-dialog-in-view", {
      "src/panel.tsx": `export default function Panel() {
  const discard = () => {
    if (!window.confirm("Discard unsaved changes?")) return;
    alert("Discarded");
    const name = globalThis.prompt("Name?");
  };
  return <div onClick={discard} />;
}
`,
    });
    expect(flagged.map((f) => f.line)).toEqual([3, 4, 5]);
    expect(flagged[0]!.message).toMatch(/window\.confirm\(\).*ConfirmDialog/);
  });

  it("accepts a local confirm, a method named confirm, and worker code", async () => {
    const clean = await lintFor("native-dialog-in-view", {
      "src/panel.tsx": `import { useConfirm } from "./dialogs";
export default function Panel({ dialog }) {
  const confirm = useConfirm();
  const go = async () => {
    if (await confirm("Discard?")) dialog.confirm();
  };
  return <div onClick={go} title="confirm(" />;
}
export const api = {
  confirm(message) {
    return Promise.resolve(Boolean(message));
  },
};
`,
      "src/index.ts": `export async function activate(host) {
  await host.showConfirm({ title: "Sure?" });
}
`,
    });
    expect(clean).toEqual([]);
  });
});

describe("native-dialog-in-view method declarations", () => {
  it("does not read a method named confirm as a call", async () => {
    const clean = await lintFor("native-dialog-in-view", {
      "src/panel.tsx": `const api = {
  confirm(message) {
    return Promise.resolve(Boolean(message));
  },
};
export default function Panel() {
  return <div onClick={() => api.confirm("x")} />;
}
`,
    });
    expect(clean).toEqual([]);
  });
});

describe("zero-build views written with createElement", () => {
  const MANIFEST = {
    name: "acme.zero",
    version: "1.0.0",
    main: "dist/index.mjs",
    engines: { daintree: ">=0.11.0" },
    contributes: { views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }] },
  };
  const panel = (head: string, body: string) => ({
    "dist/panel.js": `${head}\nexport default function Panel({ go }) {\n  return ${body};\n}\n`,
  });
  const ELEMENT_CASES: Record<string, [string, string]> = {
    "raw-button": [
      `h("button", { className: "px-2", onClick: go }, "Go")`,
      `h(Button, { onClick: go }, "Go")`,
    ],
    "raw-form-control": [
      `h("input", { value: "", placeholder: "Search" })`,
      `h("input", { type: "hidden" })`,
    ],
    "native-title-tooltip": [
      `h("span", { title: "Full path" }, "x")`,
      `h(Tooltip, { content: "Full path" }, "x")`,
    ],
    "inline-svg-icon": [
      `h("svg", { viewBox: "0 0 24 24", fill: "none" }, h("path", { d: "m9 18 6-6-6-6" }))`,
      `h("svg", { viewBox: "0 0 100 40" })`,
    ],
    "stock-palette-colour": [
      `h("div", { className: "bg-blue-500" })`,
      `h("div", { className: "bg-surface-panel" })`,
    ],
    "hand-rolled-spinner": [`h("div", { className: "animate-spin" })`, `h(Spinner, null)`],
  };

  const HEADS: Record<string, string> = {
    "import alias": `import { createElement as h, useState } from "react";`,
    "const alias of React.createElement": `import React from "react";\nconst h = React.createElement;`,
    "destructured alias": `import * as React from "react";\nconst { createElement: h } = React;`,
    "preact h": `import { h } from "preact";`,
  };

  for (const [form, head] of Object.entries(HEADS)) {
    for (const [ruleId, [bad, good]] of Object.entries(ELEMENT_CASES)) {
      // Alias resolution is shared by every rule: one form covers each rule, one rule covers each form.
      if (form !== "import alias" && ruleId !== "raw-button") continue;
      it(`${ruleId} via ${form}`, async () => {
        const flagged = await lintFor(ruleId, panel(head, bad), MANIFEST);
        expect(flagged.length).toBeGreaterThan(0);
        expect(flagged[0]).toMatchObject({
          file: "dist/panel.js",
          line: head.split("\n").length + 2,
        });
        expect(await lintFor(ruleId, panel(head, good), MANIFEST)).toEqual([]);
      });
    }
  }

  it("reads React.createElement and createElement called directly", async () => {
    const head = `import React, { createElement } from "react";`;
    for (const call of ["React.createElement", "createElement"]) {
      const flagged = await lintFor(
        "raw-button",
        panel(head, `${call}("button", { onClick: go }, "Go")`),
        MANIFEST
      );
      expect(flagged, call).toHaveLength(1);
    }
  });

  it("leaves document.createElement, an unbound h and someone else's .h() alone", async () => {
    const cases = [
      [`import React from "react";`, `(document.createElement("button"), null)`],
      [`import { hash as h } from "./hash";`, `(h("button", { title: "x" }), null)`],
      [`import { createElement as h } from "./dom";`, `(h("button", { title: "x" }), null)`],
      [`const h = document.createElement.bind(document);`, `(h("button"), null)`],
      [
        `const note = "import { createElement as h } from 'react'";`,
        `(h("button", { title: "x" }), null)`,
      ],
      [`import { createElement as h } from "react";`, `(api.h("button", { title: "x" }), null)`],
    ];
    for (const [head, body] of cases) {
      for (const ruleId of ["raw-button", "native-title-tooltip"]) {
        expect(await lintFor(ruleId, panel(head!, body!), MANIFEST), `${ruleId}: ${body}`).toEqual(
          []
        );
      }
    }
  });
});

describe("view-web-storage", () => {
  it("flags localStorage and sessionStorage in a view, bare or qualified", async () => {
    const flagged = await lintFor("view-web-storage", {
      "src/panel.tsx": `export default function Panel() {
  const tab = localStorage.getItem("tab");
  window.sessionStorage.setItem("split", "240");
  return <div>{tab}</div>;
}
`,
    });
    expect(flagged.map((f) => f.line)).toEqual([2, 3]);
    expect(flagged[0]!.message).toMatch(/usePersistentViewState/);
  });

  it("accepts a local binding, an object key, a string, and worker code", async () => {
    const clean = await lintFor("view-web-storage", {
      "src/panel.tsx": `import { localStorage } from "./memoryStore";
const config = { sessionStorage: false };
export default function Panel() {
  // localStorage would be wrong here
  return <div title="localStorage">{localStorage.get("tab")}</div>;
}
`,
      "src/index.ts": `export function activate() {
  return globalThis.localStorage;
}
`,
    });
    expect(clean).toEqual([]);
  });
});

describe("view-web-storage receivers and imports", () => {
  it("ignores another object's property and an aliased import, but not the global behind a local name", async () => {
    const flagged = await lintFor("view-web-storage", {
      "src/panel.tsx": `import { localStorage as memory } from "./memoryStore";
const localStorage = memory;
export default function Panel({ settings }) {
  const cached = settings.localStorage;
  const real = window.localStorage.getItem("tab");
  return <div>{cached}{real}{localStorage.get("x")}</div>;
}
`,
    });
    expect(flagged.map((f) => f.line)).toEqual([5]);
  });
});

describe("global-key-listener", () => {
  it("flags a keydown or keyup listener on the document or window in a view", async () => {
    const flagged = await lintFor("global-key-listener", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel() {
  useEffect(() => {
    const onKey = () => {};
    document.addEventListener("keydown", onKey);
    window.addEventListener('keyup', onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <div />;
}
`,
    });
    expect(flagged.map((f) => f.line)).toEqual([5, 6]);
    expect(flagged[0]!.message).toMatch(/useHotkeys/);
  });

  it("accepts element listeners, other events, comments and strings", async () => {
    const clean = await lintFor("global-key-listener", {
      "src/panel.tsx": `export default function Panel({ node, frame }) {
  node.addEventListener("keydown", () => {});
  frame.document.addEventListener("keydown", () => {});
  document.addEventListener("pointerdown", () => {});
  // document.addEventListener("keydown", onKey);
  const hint = 'document.addEventListener("keydown")';
  return <div title={hint} />;
}
`,
    });
    expect(clean).toEqual([]);
  });
});

describe("interval-polling-in-view", () => {
  it("flags setInterval in view code", async () => {
    const findings = await lintFor("interval-polling-in-view", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel() {
  useEffect(() => {
    const t = setInterval(() => refresh(), 1000);
    return () => clearInterval(t);
  }, []);
  return <div />;
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "src/panel.tsx", line: 4, severity: "warn" });
    // Subscribe before pulling, or a push that lands between the two is lost.
    expect(findings[0]!.hint).toMatch(/subscribe first and then pull/);
    expect(findings[0]!.hint).toMatch(/revision/);
  });

  it("leaves worker polling alone, which the docs recommend", async () => {
    const findings = await lintFor("interval-polling-in-view", {
      "src/index.ts": `export async function activate(host) {
  const timer = setInterval(() => void refresh(host), 15_000);
  return () => clearInterval(timer);
}
`,
    });
    expect(findings).toEqual([]);
  });

  it("ignores setInterval in comments and strings", async () => {
    const findings = await lintFor("interval-polling-in-view", {
      "src/panel.tsx": `// setInterval(poll, 1000) was too chatty
export default function Panel() {
  return <p>Don't call "setInterval(" here</p>;
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("interval-polling-in-view: clocks", () => {
  const withInterval = (call: string, head = "") => ({
    "src/panel.tsx": `import { useEffect, useState } from "react";
${head}export default function Panel() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = ${call};
    return () => clearInterval(t);
  }, []);
  return <div />;
}
`,
  });

  it("exempts a tick of 30 s or more, however the delay is written", async () => {
    for (const delay of ["60_000", "60000", "60 * 1000", "30_000", "MINUTE"]) {
      const findings = await lintFor(
        "interval-polling-in-view",
        withInterval(`setInterval(() => refresh(), ${delay})`, "const MINUTE = 60 * 1000;\n")
      );
      expect(findings, delay).toEqual([]);
    }
  });

  it("still flags a fast poll, and a delay it cannot read", async () => {
    for (const delay of ["29_999", "5000", "delayMs"]) {
      const findings = await lintFor(
        "interval-polling-in-view",
        withInterval(`setInterval(() => refresh(), ${delay})`)
      );
      expect(findings, delay).toHaveLength(1);
      expect(findings[0]!.message).toBe("setInterval in view code polls from the renderer");
    }
  });

  it("still flags a slow interval that visibly fetches, and a local fast delay shadowing a slow one", async () => {
    const slowFetch = await lintFor(
      "interval-polling-in-view",
      withInterval(`setInterval(() => window.electron.plugin.invoke("acme", "stats"), 60_000)`)
    );
    expect(slowFetch).toHaveLength(1);
    const shadowed = await lintFor(
      "interval-polling-in-view",
      // esbuild renames the inner DELAY, so the call reads the 1 s one it means.
      withInterval(
        `(() => { const DELAY = 1000; return setInterval(() => refresh(), DELAY); })()`,
        "const DELAY = 60_000;\n"
      )
    );
    expect(shadowed).toHaveLength(1);
  });

  it("keeps the polling message for a counter that is not named like a clock", async () => {
    const [finding] = await lintFor(
      "interval-polling-in-view",
      withInterval("setInterval(() => setCount((n) => n + 1), 1000)")
    );
    expect(finding!.message).toBe("setInterval in view code polls from the renderer");
  });

  it("points a short clock tick at useNow instead of worker polling", async () => {
    for (const callback of ["() => setTick((t) => t + 1)", "() => setNow(Date.now())"]) {
      const findings = await lintFor(
        "interval-polling-in-view",
        withInterval(`setInterval(${callback}, 1000)`)
      );
      expect(findings, callback).toHaveLength(1);
      expect(findings[0]!.message).toMatch(/ticks a clock.*useNow/);
    }
  });
});

describe("undebounced-worktree-subscription", () => {
  it("leaves onDidChangeWorktrees alone, since the host coalesces it by default", async () => {
    const findings = await lintFor("undebounced-worktree-subscription", {
      "src/index.ts": `export async function activate(host) {
  host.onDidChangeWorktrees((worktrees) => render(worktrees));
  host.onDidChangeWorktrees(render, { signal });
}
`,
    });
    expect(findings).toEqual([]);
  });

  it("flags a host fs.watch without debounceMs", async () => {
    const findings = await lintFor("undebounced-worktree-subscription", {
      "src/index.ts": `export async function activate(host) {
  host.fs.watch([dir], onChange);
  host.fs.watch([dir], onChange, { recursive: true });
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([2, 3]);
  });

  it("accepts explicit intent, including debounceMs: 0, and opaque options", async () => {
    const findings = await lintFor("undebounced-worktree-subscription", {
      "src/index.ts": `import fs from "node:fs";
export async function activate(host, opts) {
  host.onDidChangeWorktrees(render, { debounceMs: 200 });
  host.onDidChangeWorktrees(render, { debounceMs: 0 });
  host.onDidChangeWorktrees(render, opts);
  host.fs.watch([dir], onChange, { debounceMs: 100 });
  fs.watch(dir, () => {});
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("subscription-without-dispose", () => {
  it("flags a view subscription whose disposer is dropped", async () => {
    const findings = await lintFor("subscription-without-dispose", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    window.electron.plugin.on(pluginId, "slate", setSlate);
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(4);
  });

  it("does not guess about onDid* calls, which a view cannot prove return a disposer", async () => {
    const findings = await lintFor("subscription-without-dispose", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ store }) {
  useEffect(() => {
    store.onDidChange(refresh);
  }, [store]);
  return null;
}
`,
    });
    expect(findings).toEqual([]);
  });

  it("accepts a kept, returned or collected disposer", async () => {
    const findings = await lintFor("subscription-without-dispose", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    const off = window.electron.plugin.on(pluginId, "slate", setSlate);
    return () => off();
  }, [pluginId]);
  useEffect(() => window.electron.plugin.onPanel(pluginId, "doc", "p1", setDoc), [pluginId]);
  useEffect(() => {
    const subs = [];
    subs.push(window.electron.plugin.on(pluginId, "a", setA));
    return () => subs.forEach((s) => s());
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("large-inline-payload", () => {
  it("flags posting the whole collection on every iteration over it", async () => {
    const findings = await lintFor("large-inline-payload", {
      "src/index.ts": `export async function activate(host) {
  for (const item of contributions) {
    register(item);
    await host.postToPanel("contributions", contributions);
  }
  contributions.forEach((c) => host.broadcastToRenderer("all", { contributions }));
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([4, 6]);
  });

  it("accepts per-item posts and per-instance pushes in a loop", async () => {
    const findings = await lintFor("large-inline-payload", {
      "src/index.ts": `export async function activate(host) {
  for (const item of items) {
    await host.postToPanel("item", item);
  }
  for (const panelId of panels) {
    await host.postToPanel("doc", { count: items.length }, panelId);
  }
  await host.postToPanel("items", items);
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("render-on-every-event", () => {
  it("flags appending to state per event, and setting state on a high-frequency channel", async () => {
    const findings = await lintFor("render-on-every-event", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    const a = window.electron.plugin.on(pluginId, "line", (line) => setLines((prev) => [...prev, line]));
    const b = window.electron.plugin.on(pluginId, "build-progress", setProgress);
    return () => { a(); b(); };
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([4, 5]);
    expect(findings[0]!.message).toMatch(/copies the collection/);
    expect(findings[1]!.message).not.toMatch(/renders once per event/);
    for (const hook of [
      "useThrottledCallback",
      "usePluginEventSelector",
      "useVirtualList",
      "useProgressiveList",
    ]) {
      expect(findings[0]!.hint).toContain(hook);
    }
    expect(findings[0]!.hint).toMatch(/buffer flushed once per frame for appends/);
  });

  it("accepts coalesced handlers and ordinary low-frequency state", async () => {
    const findings = await lintFor("render-on-every-event", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    const a = window.electron.plugin.on(pluginId, "slate", setSlate);
    const b = window.electron.plugin.on(pluginId, "output", (chunk) => {
      pending.push(chunk);
      requestAnimationFrame(() => setOutput(pending.join("")));
    });
    return () => { a(); b(); };
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("bundled-react", () => {
  const BUILD = { "vite.config.ts": "export default {};\n" };

  it("flags a built view that carries React's own internals", async () => {
    const findings = await lintFor("bundled-react", {
      ...BUILD,
      "src/panel.tsx": "export default function Panel() { return null; }\n",
      "dist/panel.js": `import "./chunks/vendor.js";\nexport default function P() {}\n`,
      "dist/chunks/vendor.js": `/** @license React react.production.js */\nvar x = {}; x.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = {};\n`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "dist/chunks/vendor.js", severity: "error" });
  });

  it("accepts a bundle that imports React from the host import map", async () => {
    const findings = await lintFor("bundled-react", {
      ...BUILD,
      "src/panel.tsx": "export default function Panel() { return null; }\n",
      "dist/panel.js": `import { jsx } from "react/jsx-runtime";\nexport default function P() { return jsx("div", {}); }\n`,
    });
    expect(findings).toEqual([]);
  });
});

describe("whole-state-push", () => {
  it("flags re-sending a collection that only grows, alone or beside the new item", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/index.ts": `export async function activate(host) {
  const calls = [];
  host.onToolCall(async (call) => {
    calls.push(call);
    await host.postToPanel("tool-call", { call, calls });
  });
  const log = [];
  host.onLine((line) => {
    log = [...log, line];
    void host.postToPanel("log", log);
  });
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([5, 10]);
    expect(findings[0]!.hint).toMatch(/createSyncedCollection/);
    expect(findings[0]!.message).toMatch(/`calls`/);
  });

  it("flags posting the object that owns a growing member", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/state.ts": `const state = { events: [], count: 0 };
export function record(host, event) {
  state.events.push(event);
  state.count++;
  return host.postToPanel("state", state);
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 5 });
  });

  it("accepts deltas, bounded buffers and unrelated members", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/index.ts": `export async function activate(host) {
  const calls = [];
  host.onToolCall(async (call) => {
    calls.push(call);
    await host.postToPanel("tool-call", { call, total: calls.length });
  });
  const recent = [];
  host.onLine((line) => {
    recent.push(line);
    if (recent.length > 50) recent.shift();
    void host.postToPanel("recent", recent);
  });
  const state = { events: [], status: "idle" };
  host.onEvent((event) => {
    state.events.push(event);
    void host.postToPanel("status", state.status);
  });
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("whole-state-push: a project plugin built from outside its own directory", () => {
  const BUNDLED_WORKER = `export async function activate(host) {
  const issues = [];
  host.onIssue((issue) => {
    issues.push(issue);
    void host.postToPanel("issues", issues);
  });
}
`;
  const MANIFEST = { name: "acme.ledger", version: "1.0.0", main: "dist/index.mjs" };
  const SOURCE = { "src/index.ts": "export async function activate() {}\n" };

  it("reads the bundle as build output when a build.mjs sits beside it", async () => {
    const findings = await lintFor(
      "whole-state-push",
      { "build.mjs": "await build({});\n", "dist/index.mjs": BUNDLED_WORKER },
      MANIFEST
    );
    expect(findings).toEqual([]);
  });

  it("reads the bundle as build output when src/ sits beside an entry in dist/", async () => {
    const findings = await lintFor(
      "whole-state-push",
      { ...SOURCE, "dist/index.mjs": BUNDLED_WORKER },
      MANIFEST
    );
    expect(findings).toEqual([]);
  });

  it("still reads dist/ as source beside a src/ of plain JS command handlers", async () => {
    const findings = await lintFor(
      "whole-state-push",
      {
        "src/plan-from-issue.js": "export default async () => {};\n",
        "dist/index.mjs": BUNDLED_WORKER,
      },
      MANIFEST
    );
    expect(findings).toHaveLength(1);
  });

  it("still reads a zero-build entry in dist/ as source", async () => {
    const findings = await lintFor(
      "whole-state-push",
      { "dist/index.mjs": BUNDLED_WORKER },
      MANIFEST
    );
    expect(findings).toHaveLength(1);
  });
});

describe("whole-state-push: buffers flushed and replaced", () => {
  it("accepts a buffer reassigned to a fresh array after it is posted", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/index.ts": `export async function activate(host) {
  let buf = [];
  host.onLine((line) => {
    buf.push(line);
  });
  const timer = setInterval(() => {
    void host.postToPanel("lines", buf);
    buf = [];
  }, 100);
  let queue = new Array();
  host.onEvent((event) => {
    queue.push(event);
    host.postToPanel("events", { queue });
    queue = new Array();
  });
  const state = { calls: [] };
  host.onToolCall((call) => {
    state.calls.push(call);
    host.postToPanel("calls", state);
    state.calls = [];
  });
  return () => clearInterval(timer);
}
`,
    });
    expect(findings).toEqual([]);
  });

  it("still flags a buffer only declared empty, or reset before it is posted", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/index.ts": `export async function activate(host) {
  let buf = [];
  host.onLine((line) => {
    buf.push(line);
    void host.postToPanel("lines", buf);
  });
  let log = [];
  host.onReset(() => {
    log = [];
  });
  host.onEntry((entry) => {
    log.push(entry);
    void host.postToPanel("log", log);
    if (log === []) return;
  });
  let seen = [];
  host.onSeen((item) => {
    seen.push(item);
    void host.postToPanel("seen", seen);
  });
  host.onClear(() => {
    seen = [];
  });
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([5, 13, 19]);
  });

  it("accepts a spread or concat that is capped as it is rebuilt", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/index.ts": `export async function activate(host) {
  let recent = [];
  host.onLine((line) => {
    recent = [...recent, line].slice(-100);
    void host.postToPanel("recent", recent);
  });
  let tail = [];
  host.onChunk((chunk) => {
    tail = tail.concat(chunk).slice(-50);
    void host.postToPanel("tail", tail);
  });
  let all = [];
  host.onItem((item) => {
    all = [...all, item];
    void host.postToPanel("all", all);
  });
  let copied = [];
  host.onCopy((item) => {
    copied = [...copied, item].slice();
    void host.postToPanel("copied", copied);
  });
  let fromZero = [];
  host.onZero((item) => {
    fromZero = fromZero.concat(item).slice(0);
    void host.postToPanel("fromZero", fromZero);
  });
  let windowed = [];
  host.onWindow((item) => {
    windowed = [...windowed, item]
      // keep the newest page
      .slice(0, 200);
    void host.postToPanel("windowed", windowed);
  });
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([15, 20, 25]);
  });
});

describe("render-on-every-event: capped appends", () => {
  it("does not call a capped append a growing copy", async () => {
    const findings = await lintFor("render-on-every-event", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    const a = window.electron.plugin.on(pluginId, "notice", (n) => setNotices((prev) => [...prev, n].slice(-20)));
    const b = window.electron.plugin.on(pluginId, "line", (line) => setLines((prev) => [...prev, line].slice(-500)));
    const c = window.electron.plugin.on(pluginId, "notice", (n) => setAll((prev) => prev.concat(n)));
    return () => { a(); b(); c(); };
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([5, 6]);
    expect(findings[0]!.message).toMatch(/every "line" event/);
    expect(findings[1]!.message).toMatch(/copies the collection/);
  });
});

describe("perf hints point at the SDK hooks", () => {
  it("names useStreamBuffer and useSyncedCollection for per-event appends", async () => {
    const findings = await lintFor("render-on-every-event", {
      "src/panel.tsx": `import { usePluginEvent } from "@daintreehq/plugin-sdk/react";
export default function Panel({ pluginId }) {
  const [lines, setLines] = useState([]);
  usePluginEvent(pluginId, "output", (line) => setLines((prev) => [...prev, line]));
  return <pre>{lines.join("")}</pre>;
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.hint).toMatch(/useStreamBuffer/);
    expect(findings[0]!.hint).toMatch(/useSyncedCollection/);
  });
});
