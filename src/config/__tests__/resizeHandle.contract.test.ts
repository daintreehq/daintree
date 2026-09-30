import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const ROOTS = ["src", "plugins"].map((dir) => path.join(REPO_ROOT, dir));
const PRIMITIVE = "src/components/ui/ResizeHandle.tsx";

// Every draggable edge renders through the shared ResizeHandle, so its target size,
// grip ink, focus outline, reset gesture and label can't drift one copy at a time.
const SEPARATOR_ROLE = /role(=|:\s*|=\{\s*)["']separator["']/;

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

describe("resize handle contract", () => {
  it("renders every separator through the shared ResizeHandle", () => {
    const offenders = ROOTS.flatMap(collect)
      .map((file) => path.relative(REPO_ROOT, file))
      .filter((rel) => rel !== path.normalize(PRIMITIVE))
      .filter((rel) => SEPARATOR_ROLE.test(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")));
    expect(
      offenders,
      `Hand-rolled role="separator" found. Use <ResizeHandle> from ${PRIMITIVE} with useSplitterKeys.`
    ).toEqual([]);
  });

  it("still finds the primitive, so the scan is not vacuous", () => {
    expect(SEPARATOR_ROLE.test(fs.readFileSync(path.join(REPO_ROOT, PRIMITIVE), "utf8"))).toBe(
      true
    );
  });
});
