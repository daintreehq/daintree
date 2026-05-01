import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent header reveal — issue #6420", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("does not use visibility:hidden (invisible/visible) for the header reveal — breaks keyboard focus", () => {
    expect(source).not.toMatch(/invisible[^"']*group-(hover|focus-within)\/header:visible/);
  });

  it("hides the header reveal wrapper with opacity-0 + pointer-events-none so buttons stay in tab order", () => {
    expect(source).toContain("opacity-0");
    expect(source).toContain("pointer-events-none");
    expect(source).toContain("group-hover/header:opacity-100");
    expect(source).toContain("group-hover/header:pointer-events-auto");
    expect(source).toContain("group-focus-within/header:opacity-100");
    expect(source).toContain("group-focus-within/header:pointer-events-auto");
  });

  it("keeps the named group/header parent so focus-within and hover variants resolve", () => {
    expect(source).toMatch(/className="[^"]*\bgroup\/header\b/);
  });

  it("uses Tier 1 transition-opacity duration-150 for the reveal", () => {
    expect(source).toMatch(/transition-opacity[^"]*duration-150/);
  });
});
