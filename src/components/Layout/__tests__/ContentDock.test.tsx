// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("ContentDock regression test", () => {
  it("does not import or render ClusterAttentionPill", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("ClusterAttentionPill");
    expect(content).not.toContain('from "@/components/Fleet"');
  });
});
