import { afterEach, describe, expect, it } from "vitest";
import { formatLintReport, runLint } from "../commands/lint.js";
import { lintPlugin, LINT_RULES, STYLE_REPORT_RULE_ID } from "../lib/lint/index.js";
import { scanSource } from "../lib/lint/source.js";
import { cleanupPlugins, VIEW_MANIFEST, writePlugin } from "./lintFixtures.js";

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
