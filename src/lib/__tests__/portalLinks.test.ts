import { describe, expect, it } from "vitest";
import type { PortalLink } from "@shared/types";
import type { GlobalLink } from "@/store/globalLinksStore";
import { withGlobalLinks } from "../portalLinks";

const builtIn = (key: string, order: number): PortalLink => ({
  id: `system-${key}`,
  title: key,
  url: `https://${key}.test`,
  icon: key,
  type: "system",
  enabled: true,
  order,
});
const mine = (id: string, order: number): GlobalLink => ({
  id,
  title: id,
  url: `https://${id}.test`,
  icon: "globe",
  enabled: true,
  order,
});

describe("withGlobalLinks", () => {
  it("lists global links after every built-in one, each group in its own order, under one sort", () => {
    const system = [builtIn("claude", 0), builtIn("gemini", 4), builtIn("grok", 1)];
    const global = [mine("user-a", -2), mine("user-b", 0.5), mine("user-c", 7)];

    const sorted = withGlobalLinks(system, global).sort((a, b) => a.order - b.order);

    expect(sorted.map((l) => l.id)).toEqual([
      "system-claude",
      "system-grok",
      "system-gemini",
      "user-a",
      "user-b",
      "user-c",
    ]);
    expect(sorted.slice(3).every((l) => l.type === "user")).toBe(true);
  });

  it("starts global links at the top when there are no built-in links", () => {
    const sorted = withGlobalLinks([], [mine("user-a", 3), mine("user-b", 5)]);
    expect(sorted.map((l) => [l.id, l.order])).toEqual([
      ["user-a", 0],
      ["user-b", 1],
    ]);
  });
});
