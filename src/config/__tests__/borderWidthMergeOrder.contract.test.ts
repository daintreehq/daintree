import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = ["src", "plugins"].map((dir) => path.join(REPO_ROOT, dir));

// `cn()` is tailwind-merge, which resolves conflicts last-wins. An all-sides
// border width (`border`, `border-2`, `border-[1px]`) placed after a side
// width (`border-l-[3px]`) erases the side width, so a severity edge renders
// as the same hairline as the other three sides. The toast and the re-entry
// summary both shipped that way. Put the all-sides width first.
const SIDE_WIDTH = /(?<![\w:-])border-(?:[xytrblse])-(?:\d+|\[\d+px\])(?![\w-])/;
const ALL_SIDES_WIDTH = /(?<![\w:-])border(?:-\d+|-\[\d+px\])?(?![\w/[-])/g;
const STRING_LITERAL = /"[^"\n]*"|`[^`]*`/g;

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "node_modules", "dist"].includes(entry.name)) continue;
      result.push(...collectSourceFiles(fullPath));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}

function sideWidthErasedIn(classes: string): boolean {
  const side = SIDE_WIDTH.exec(classes);
  if (!side) return false;
  for (const match of classes.matchAll(ALL_SIDES_WIDTH)) {
    if (match.index > side.index) return true;
  }
  return false;
}

describe("border width merge order contract", () => {
  it("recognises the erasing order and allows the safe one", () => {
    expect(sideWidthErasedIn("border-l-[3px] border border-tint/[0.08]")).toBe(true);
    expect(sideWidthErasedIn("border-t-2 border-2")).toBe(true);
    expect(sideWidthErasedIn("border border-tint/[0.08] border-l-[3px]")).toBe(false);
    expect(sideWidthErasedIn("border-l-[3px] border-l-status-error border-tint/10")).toBe(false);
    expect(sideWidthErasedIn("hover:border border-l-2")).toBe(false);
  });

  it("never lists an all-sides border width after a side width in one class string", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        const source = fs.readFileSync(file, "utf8");
        for (const literal of source.matchAll(STRING_LITERAL)) {
          if (sideWidthErasedIn(literal[0])) {
            const line = source.slice(0, literal.index).split("\n").length;
            offenders.push(`${path.relative(REPO_ROOT, file)}:${line} ${literal[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
