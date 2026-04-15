import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const FILE_PATH = resolve(__dirname, "../ArtifactOverlay.tsx");

describe("ArtifactOverlay — contrast on neutral surfaces (issue #4611)", () => {
  it("buttons on bg-daintree-border use daintree-text, not text-inverse", async () => {
    const content = await readFile(FILE_PATH, "utf-8");
    expect(content).not.toMatch(/bg-daintree-border[^"]*text-text-inverse/);
  });
});
