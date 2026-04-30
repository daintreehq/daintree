import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

// Tailwind v4 changed `outline-none` to emit `outline-style: none`, which removes
// the focus outline entirely in forced-colors / Windows High Contrast mode. The
// v3 behavior — `outline: 2px solid transparent` — moved to `outline-hidden`.
// All Tailwind utility usages must use `outline-hidden` so the system can recolor
// focus indicators in forced-colors mode.
const FORBIDDEN_PATTERN = /\boutline-none\b/g;

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      result.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;

    result.push(fullPath);
  }

  return result;
}

describe("outline-hidden contract (forced-colors compatibility)", () => {
  it("no source files use the Tailwind utility outline-none (use outline-hidden)", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const offenders: { file: string; line: number; text: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      if (!FORBIDDEN_PATTERN.test(content)) continue;
      FORBIDDEN_PATTERN.lastIndex = 0;

      const lines = content.split("\n");
      lines.forEach((text, idx) => {
        if (FORBIDDEN_PATTERN.test(text)) {
          offenders.push({
            file: path.relative(REPO_ROOT, file),
            line: idx + 1,
            text: text.trim(),
          });
        }
        FORBIDDEN_PATTERN.lastIndex = 0;
      });
    }

    if (offenders.length > 0) {
      const detail = offenders
        .slice(0, 20)
        .map((o) => `  ${o.file}:${o.line} — ${o.text}`)
        .join("\n");
      const more = offenders.length > 20 ? `\n  …and ${offenders.length - 20} more` : "";
      throw new Error(
        `Found ${offenders.length} use(s) of outline-none. ` +
          `Replace with outline-hidden so focus stays visible in forced-colors mode:\n${detail}${more}`
      );
    }

    expect(offenders).toEqual([]);
  });
});
