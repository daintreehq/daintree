import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const FILE_PATH = resolve(__dirname, "../ProblemsContent.tsx");

describe("ProblemsContent — hover contrast (issue #4611)", () => {
  it("error row hover uses canopy-text, not text-inverse", async () => {
    const content = await readFile(FILE_PATH, "utf-8");
    expect(content).toContain("hover:text-canopy-text");
    expect(content).not.toContain("hover:text-text-inverse");
  });
});
