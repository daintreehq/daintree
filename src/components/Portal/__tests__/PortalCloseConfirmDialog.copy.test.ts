import { describe, it, expect } from "vitest";
import type { PortalTab } from "@shared/types";
import { buildCopy } from "../PortalCloseConfirmDialog";

const tabs = (n: number): PortalTab[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, url: `https://x/${i}`, title: `T${i}` }));

describe("PortalCloseConfirmDialog buildCopy", () => {
  it("closeAll: question title, verb-noun confirm label, accurate count", () => {
    const copy = buildCopy({ kind: "closeAll", tabsToClose: tabs(3) });
    expect(copy.title).toBe("Close all portal tabs?");
    expect(copy.confirmLabel).toBe("Close 3 portal tabs");
    expect(copy.description).toContain("3 tabs will close");
    // Microcopy guard: ConfirmDialog dev-warns on generic irreversibility copy.
    expect(copy.description).not.toMatch(/cannot be undone/i);
  });

  it("closeOthers: never claims 'active' — kept tab is the invoked tab, not the active one", () => {
    const copy = buildCopy({ kind: "closeOthers", tabsToClose: tabs(4), keepTabId: "keep" });
    expect(copy.title).toBe("Close other portal tabs?");
    expect(copy.confirmLabel).toBe("Close 4 portal tabs");
    expect(copy.description).not.toMatch(/active/i);
    expect(copy.description).toContain("4 tabs will close");
  });

  it("singularizes the noun for a single closing tab", () => {
    const copy = buildCopy({ kind: "closeAll", tabsToClose: tabs(1) });
    expect(copy.confirmLabel).toBe("Close 1 portal tab");
    expect(copy.description).toContain("1 tab will close");
  });
});
