import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const FILE_PATH = resolve(__dirname, "../PortalLaunchpad.tsx");

describe("PortalLaunchpad — hover contrast (issue #4611)", () => {
  it("portal card hover uses canopy-text, not text-inverse", async () => {
    const content = await readFile(FILE_PATH, "utf-8");
    expect(content).toContain("group-hover:text-canopy-text");
    expect(content).not.toContain("group-hover:text-text-inverse");
  });
});
