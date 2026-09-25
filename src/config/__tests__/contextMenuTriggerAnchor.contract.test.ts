import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

// `ContextMenuTrigger asChild` hands its `onContextMenu` handler and ref to its
// immediate child. `Tooltip` is a provider that renders no DOM of its own: it
// spreads what it is given onto the Radix tooltip root, which drops both. So a
// trigger whose child is a `<Tooltip>` never opens its menu on right-click.
// The child has to be a real element — the toolbar wraps the tooltip in an
// `inline-flex` span.
const TRIGGER_THEN_TOOLTIP = /<ContextMenuTrigger\s+asChild\s*>\s*<Tooltip[\s>]/g;

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...listTsx(full));
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

describe("context menu trigger anchor contract", () => {
  it("never makes a Tooltip the direct child of an asChild ContextMenuTrigger", () => {
    const offenders: string[] = [];
    for (const file of listTsx(SRC_ROOT)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(TRIGGER_THEN_TOOLTIP)) {
        offenders.push(`${path.relative(REPO_ROOT, file)}:${lineOf(source, match.index)}`);
      }
    }
    expect(offenders, `wrap the Tooltip in a DOM element:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("recognises the broken shape it guards against", () => {
    const broken = `<ContextMenuTrigger asChild>\n  <Tooltip>\n    <TooltipTrigger asChild />`;
    const anchored = `<ContextMenuTrigger asChild>\n  <span className="inline-flex">\n    <Tooltip>`;
    expect(broken.match(TRIGGER_THEN_TOOLTIP)).not.toBeNull();
    expect(anchored.match(TRIGGER_THEN_TOOLTIP)).toBeNull();
  });
});
