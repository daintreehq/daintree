import { describe, it, expect } from "vitest";
import { buildDisplayPaths } from "../projectDisplayPath";

describe("buildDisplayPaths", () => {
  it("uses the bare folder name when nothing collides", () => {
    const paths = buildDisplayPaths([
      { id: "a", path: "/Users/greg/code/storefront" },
      { id: "b", path: "/Users/greg/code/invoices" },
    ]);

    expect(paths.get("a")).toBe("storefront");
    expect(paths.get("b")).toBe("invoices");
  });

  it("grows only the colliding entries, leaving the rest short", () => {
    const paths = buildDisplayPaths([
      { id: "pay", path: "/code/acme/payments/api" },
      { id: "ident", path: "/code/acme/identity/api" },
      { id: "docs", path: "/code/acme/docs" },
    ]);

    expect(paths.get("pay")).toBe("payments/api");
    expect(paths.get("ident")).toBe("identity/api");
    // Untouched: growing every row to match the worst case is what makes long
    // paths unreadable in the first place.
    expect(paths.get("docs")).toBe("docs");
  });

  it("keeps growing until the suffix is actually unique", () => {
    const paths = buildDisplayPaths([
      { id: "one", path: "/code/red/payments/api" },
      { id: "two", path: "/code/blue/payments/api" },
    ]);

    expect(paths.get("one")).toBe("red/payments/api");
    expect(paths.get("two")).toBe("blue/payments/api");
  });

  it("normalises Windows separators", () => {
    const paths = buildDisplayPaths([
      { id: "a", path: "C:\\code\\acme\\payments\\api" },
      { id: "b", path: "C:\\code\\acme\\identity\\api" },
    ]);

    expect(paths.get("a")).toBe("payments/api");
    expect(paths.get("b")).toBe("identity/api");
  });

  it("stops at the full path rather than looping when a tail repeats", () => {
    const paths = buildDisplayPaths([
      { id: "short", path: "/api" },
      { id: "long", path: "/code/acme/api" },
    ]);

    // The shorter path is exhausted before it can be disambiguated by growth,
    // so it settles on everything it has instead of spinning.
    expect(paths.get("short")).toBe("api");
    expect(paths.get("long")).toBe("acme/api");
  });

  it("gives colliding siblings distinct labels, not just non-empty ones", () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      path: `/code/group-${i}/service`,
    }));

    const paths = buildDisplayPaths(projects);

    expect(paths.size).toBe(12);
    // A label per project is worthless if they're all the same string.
    expect(new Set(paths.values()).size).toBe(12);
    expect(paths.get("p3")).toBe("group-3/service");
  });

  it("falls back to the full path when the shared tail is deeper than the growth limit", () => {
    const projects = [
      { id: "a", path: "/one/w/x/y/z/service" },
      { id: "b", path: "/two/w/x/y/z/service" },
    ];

    const paths = buildDisplayPaths(projects);

    // Five shared trailing segments exceed the four-segment growth budget, so
    // each settles on its whole normalized path rather than an ambiguous tail.
    expect(paths.get("a")).toBe("one/w/x/y/z/service");
    expect(paths.get("b")).toBe("two/w/x/y/z/service");
    expect(paths.get("a")).not.toBe(paths.get("b"));
  });

  it("never yields an empty label for a root or blank path", () => {
    const paths = buildDisplayPaths([
      { id: "root", path: "/" },
      { id: "blank", path: "" },
      { id: "normal", path: "/code/app" },
    ]);

    // An empty string would render as a blank line the user can't act on.
    expect(paths.get("root")).toBeTruthy();
    expect(paths.get("blank")).toBeTruthy();
    expect(paths.get("normal")).toBe("app");
  });

  it("handles an empty project list", () => {
    expect(buildDisplayPaths([]).size).toBe(0);
  });

  it("preserves unicode and emoji segments", () => {
    const paths = buildDisplayPaths([
      { id: "a", path: "/code/日本語/api" },
      { id: "b", path: "/code/🚀-launch/api" },
    ]);

    expect(paths.get("a")).toBe("日本語/api");
    expect(paths.get("b")).toBe("🚀-launch/api");
  });
});
