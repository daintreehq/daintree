// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("DockedTerminalItem", () => {
  const content = readFileSync(resolve(__dirname, "../DockedTerminalItem.tsx"), "utf-8");

  it("preserves click/double-click handler structure through the new wrappers", () => {
    expect(content).toContain("onClick={");
    expect(content).toContain("onDoubleClick={");
  });

  it("includes explicit animation classes on PopoverContent matching base popover Tier 2 timing", () => {
    expect(content).toContain("data-[state=open]:animate-in");
    expect(content).toContain("data-[state=closed]:animate-out");
    expect(content).toContain("data-[state=open]:duration-200");
    expect(content).toContain("data-[state=closed]:duration-[120ms]");
    expect(content).toContain("data-[state=open]:fade-in-0");
    expect(content).toContain("data-[state=closed]:fade-out-0");
    expect(content).toContain("data-[state=open]:zoom-in-97");
    expect(content).toContain("data-[state=closed]:zoom-out-97");
    expect(content).toContain("data-[side=bottom]:slide-in-from-top-1");
    expect(content).toContain("data-[side=left]:slide-in-from-right-1");
    expect(content).toContain("data-[side=right]:slide-in-from-left-1");
    expect(content).toContain("data-[side=top]:slide-in-from-bottom-1");
  });

  it("keeps existing dock popover guards intact", () => {
    expect(content).toContain("handleDockInteractOutside");
    expect(content).toContain("handleDockEscapeKeyDown");
  });
});
