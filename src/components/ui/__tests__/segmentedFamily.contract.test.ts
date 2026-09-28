import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every single-choice segmented control renders through `SegmentedRadioGroup`,
// so they share one track, one thumb, one keyboard model and one slide. The
// family drifted apart once already — a second primitive plus three hand-rolled
// copies, each with its own thumb — and the thumb is the part every copy
// re-spells. Read from source because what is guarded is how the controls are
// written, not what any one renders today.

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../..");
const REPO = path.resolve(SRC, "..");
// Builtin plugin renderers import the host's primitives through `@/`, so they
// are the same family and have to be scanned with it.
const ROOTS = [SRC, path.join(REPO, "plugins", "builtin")];
const PRIMITIVE = path.resolve(here, "../SegmentedRadioGroup.tsx");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "__preview__", "node_modules", "dist"].includes(entry.name)) continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("segmented control family", () => {
  it("draws a segmented thumb in exactly one place: the shared primitive", () => {
    const drawers = ROOTS.flatMap(sourceFiles).filter((file) =>
      fs.readFileSync(file, "utf8").includes("segmented-thumb")
    );

    expect(drawers.map((file) => path.relative(REPO, file))).toEqual([
      path.relative(REPO, PRIMITIVE),
    ]);
  });
});
