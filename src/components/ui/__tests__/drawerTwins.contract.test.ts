import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The dev preview's output drawer and the diagnostics dock are one control
// built twice, and they drifted apart once: two tab recipes, two count pills,
// a blue focus ring, three disabled opacities and an off-ladder hover. Read
// from source because what is guarded is how they are written.

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const TAB_HOSTS = [
  "src/components/DevPreview/ConsoleDrawer.tsx",
  "src/components/Diagnostics/DiagnosticsDock.tsx",
  "src/components/Settings/SettingsSubtabBar.tsx",
];

const TWIN_FILES = [
  "src/components/DevPreview/ConsoleDrawer.tsx",
  "src/components/DevPreview/ConsolePanel.tsx",
  "src/components/DevPreview/DiagnosticsPanel.tsx",
  "src/components/Diagnostics/DiagnosticsDock.tsx",
];

describe("drawer twins", () => {
  it("draw their tab strips only through the shared UnderlineTabs", () => {
    for (const rel of TAB_HOSTS) {
      const src = read(rel);
      expect(src, rel).toMatch(/<UnderlineTabs\b/);
      expect(src, rel).not.toMatch(/role="tab"/);
    }
  });

  it("keep one focus ring, one hover ladder and one disabled dim", () => {
    const offenders: string[] = [];
    for (const rel of TWIN_FILES) {
      const src = read(rel);
      for (const pattern of [
        /ring-status-info/,
        /ring-offset/,
        /focus-visible:ring-/,
        /hover:bg-overlay-medium/,
        /disabled:opacity-(?!50\b)\d+/,
        /\bborder-overlay\/\d+/,
        /aria-pressed/,
      ]) {
        // Row hairlines inside the console list are a different role from the
        // strip dividers and keep their own weight.
        const hits = src
          .split("\n")
          .filter((line) => pattern.test(line) && !line.includes("group/row"));
        if (hits.length > 0) offenders.push(`${rel}: ${pattern} × ${hits.length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("move their height on one rule that reduced motion switches off", () => {
    const css = read("src/index.css");
    const block = css.slice(css.indexOf("@variant reduce-motion {\n  .diagnostics-dock"));
    const reduced = block.slice(0, block.indexOf("}\n}"));
    expect(reduced).toMatch(/\.console-drawer-region/);
    // Height moves on a transition, the dock's contents on an animation; both stop.
    expect(reduced).toMatch(/transition:\s*none/);
    expect(reduced).toMatch(/animation:\s*none/);
    expect(read("src/components/DevPreview/ConsoleDrawer.tsx")).toMatch(/console-drawer-region/);
    expect(read("src/components/Diagnostics/DiagnosticsDock.tsx")).toMatch(/diagnostics-dock/);
  });

  it("let the global reduced-motion rule reach every rotating chevron", () => {
    for (const rel of [
      "src/components/DevPreview/ConsoleDrawer.tsx",
      "src/components/Diagnostics/ProblemsContent.tsx",
      "src/components/Diagnostics/LogsContent.tsx",
    ]) {
      const src = read(rel);
      const rotating = [...src.matchAll(/<Chevron(?:Up|Down|Right)\b([\s\S]*?)\/>/g)].filter((m) =>
        /rotate-/.test(m[1]!)
      );
      expect(rotating.length, rel).toBeGreaterThan(0);
      for (const m of rotating) expect(m[1], rel).toMatch(/data-animated-chevron/);
    }
  });
});
