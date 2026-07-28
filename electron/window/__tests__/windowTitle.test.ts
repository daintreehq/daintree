import { describe, expect, it } from "vitest";
import {
  composeWindowTitle,
  resolveWindowProjectName,
  type ProjectTitleLookup,
  type ProjectTitleRow,
  type TitleProjectViewManager,
} from "../windowTitle.js";

function pvm(activeId: string | null, bridgedId: string | null = null): TitleProjectViewManager {
  return {
    getActiveProjectId: () => activeId,
    getOutgoingBridgeProjectId: () => bridgedId,
  };
}

function lookupOf(rows: Record<string, ProjectTitleRow>): ProjectTitleLookup {
  return (projectId) => rows[projectId] ?? null;
}

/** The C0 range plus DEL — what an NSWindow title must not carry. */
function isStrippedControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

describe("composeWindowTitle", () => {
  it("uses the project name alone when nothing is waiting", () => {
    expect(composeWindowTitle("checkout-api", 0)).toBe("checkout-api");
  });

  it("prefixes the waiting count without disturbing the name", () => {
    const name = "checkout-api";
    expect(composeWindowTitle(name, 3)).toBe(`(3) ${composeWindowTitle(name, 0)}`);
  });

  it("treats every unusable name as the same no-project fallback", () => {
    const fallback = composeWindowTitle(null, 0);

    expect(composeWindowTitle(undefined, 0)).toBe(fallback);
    expect(composeWindowTitle("", 0)).toBe(fallback);
    expect(composeWindowTitle("   ", 0)).toBe(fallback);
    expect(composeWindowTitle("\n\t", 0)).toBe(fallback);
  });

  it("counts a waiting prefix onto the fallback too", () => {
    expect(composeWindowTitle(null, 2)).toBe(`(2) ${composeWindowTitle(null, 0)}`);
  });

  it("does not repeat the app name after a project name", () => {
    const fallback = composeWindowTitle(null, 0);
    expect(composeWindowTitle("checkout-api", 0)).not.toContain(fallback);
  });

  it("strips surrounding whitespace rather than passing it into the title", () => {
    expect(composeWindowTitle("  checkout-api  ", 0)).toBe(composeWindowTitle("checkout-api", 0));
  });

  it("replaces embedded control characters so the title stays one line", () => {
    const title = composeWindowTitle("check\nout\tapi", 0);

    expect([...title].some((ch) => isStrippedControl(ch))).toBe(false);
    expect(title).toContain("check");
    expect(title).toContain("api");
  });

  it("strips DEL as well as the low control range", () => {
    const title = composeWindowTitle("del\u007Fimited", 0);

    expect([...title].some((ch) => isStrippedControl(ch))).toBe(false);
    expect(title).toContain("del");
    expect(title).toContain("imited");
  });

  it("shortens a runaway name and marks where it was cut", () => {
    const long = "x".repeat(400);
    const title = composeWindowTitle(long, 0);
    const points = [...title];

    expect(points.length).toBeLessThan(long.length);
    expect(title.startsWith("xx")).toBe(true);
    expect(points[points.length - 1]).not.toBe("x");
  });

  it("keeps the count readable when the name is truncated", () => {
    const long = "x".repeat(400);
    expect(composeWindowTitle(long, 7).startsWith("(7) ")).toBe(true);
  });

  it("leaves a name at the length ceiling untouched", () => {
    const atCeiling = "y".repeat(100);
    expect(composeWindowTitle(atCeiling, 0)).toBe(atCeiling);
  });

  it("shortens a name one past the ceiling to the ceiling", () => {
    const atCeiling = "y".repeat(100);
    const overBy1 = "y".repeat(101);
    const title = composeWindowTitle(overBy1, 0);

    expect(title).not.toBe(overBy1);
    expect([...title]).toHaveLength([...atCeiling].length);
  });

  it("counts astral characters as one, so truncation never splits a surrogate pair", () => {
    const emojiName = "🌲".repeat(120);
    const title = composeWindowTitle(emojiName, 0);
    const points = [...title];

    expect(points).toHaveLength(100);
    expect(points.slice(0, 99).every((ch) => ch === "🌲")).toBe(true);
    // A split pair would surface as an unpaired surrogate rather than the tree.
    expect(title).not.toContain("�");
    expect([...title].some((ch) => ch.charCodeAt(0) >= 0xd800 && ch.length === 1)).toBe(false);
  });

  it("keeps an astral name at the ceiling whole", () => {
    const atCeiling = "🌲".repeat(100);
    expect(composeWindowTitle(atCeiling, 0)).toBe(atCeiling);
  });
});

describe("resolveWindowProjectName", () => {
  const rows = lookupOf({
    "proj-open": { name: "checkout-api", status: "active" },
    "proj-background": { name: "billing", status: "background" },
    "proj-closed": { name: "archived", status: "closed" },
    "proj-missing-status": { name: "no-status" },
    "proj-missing": { name: "on-a-dead-mount", status: "missing" },
  });

  it("names the project the window has active", () => {
    expect(resolveWindowProjectName(pvm("proj-open"), rows)).toBe("checkout-api");
  });

  it("prefers the still-painted bridge over the incoming project mid-switch", () => {
    expect(resolveWindowProjectName(pvm("proj-open", "proj-background"), rows)).toBe("billing");
  });

  it("falls through to the active project when the bridge names a closed row", () => {
    expect(resolveWindowProjectName(pvm("proj-open", "proj-closed"), rows)).toBe("checkout-api");
  });

  it("keeps a project visible in an unfocused window, which reads as background", () => {
    expect(resolveWindowProjectName(pvm("proj-background"), rows)).toBe("billing");
  });

  it("accepts a row with no status rather than treating it as closed", () => {
    expect(resolveWindowProjectName(pvm("proj-missing-status"), rows)).toBe("no-status");
  });

  it("still names a project whose folder went missing — it is open, just unreachable", () => {
    expect(resolveWindowProjectName(pvm("proj-missing"), rows)).toBe("on-a-dead-mount");
  });

  it("reports no project once the row is closed but the binding lingers", () => {
    expect(resolveWindowProjectName(pvm("proj-closed"), rows)).toBeNull();
  });

  it("reports no project for an id with no row, as a scratch workspace has", () => {
    expect(resolveWindowProjectName(pvm("scratch-uuid"), rows)).toBeNull();
  });

  it("reports no project for an unbound window", () => {
    expect(resolveWindowProjectName(pvm(null), rows)).toBeNull();
  });

  it("reports no project when the window has no view manager", () => {
    expect(resolveWindowProjectName(undefined, rows)).toBeNull();
  });

  it("reports no project when no lookup was injected", () => {
    expect(resolveWindowProjectName(pvm("proj-open"), null)).toBeNull();
  });
});
