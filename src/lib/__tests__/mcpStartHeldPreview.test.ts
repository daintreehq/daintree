import { describe, expect, it } from "vitest";
import { formatStartHeldPreviewLines } from "../mcpStartHeldPreview";
import { hasCautionLine, isCautionPreviewLine } from "@/lib/mcpPreviewLines";

const HELD = { title: "codex triage", reason: "host-ended-uncleanly", sessionId: "sess-1" };

describe("formatStartHeldPreviewLines (#15270)", () => {
  it("names the recorded conversation a resume reopens", () => {
    const lines = formatStartHeldPreviewLines("resume", HELD);

    expect(lines.some((line) => line.startsWith("Resumes:") && line.includes("sess-1"))).toBe(
      true
    );
    expect(lines.some((line) => line.includes("host-ended-uncleanly"))).toBe(true);
    expect(lines.some((line) => line.includes("codex triage"))).toBe(true);
    expect(hasCautionLine(lines)).toBe(false);
  });

  it("says a fresh start leaves the recorded conversation unopened", () => {
    const lines = formatStartHeldPreviewLines("fresh", HELD);

    expect(lines.some((line) => line.startsWith("Resumes:"))).toBe(false);
    const starts = lines.find((line) => line.startsWith("Starts:"));
    expect(starts).toContain("new conversation");
    expect(starts).toContain("sess-1");
  });

  it("names no conversation for a fresh start of a hold that recorded none", () => {
    const lines = formatStartHeldPreviewLines("fresh", { ...HELD, sessionId: undefined });

    expect(lines.find((line) => line.startsWith("Starts:"))).not.toContain("(");
    expect(hasCautionLine(lines)).toBe(false);
  });

  it("warns that a resume with nothing recorded will be refused", () => {
    const lines = formatStartHeldPreviewLines("resume", { ...HELD, sessionId: undefined });

    expect(hasCautionLine(lines)).toBe(true);
    expect(lines.some((line) => line.startsWith("Resumes:"))).toBe(false);
  });

  it("warns, and describes no start, for a pane that isn't held", () => {
    const lines = formatStartHeldPreviewLines("resume", undefined);

    expect(lines).toHaveLength(1);
    expect(isCautionPreviewLine(lines[0]!)).toBe(true);
  });

  it("keeps a title on one line, so it can't open a caution line of its own", () => {
    const lines = formatStartHeldPreviewLines("fresh", {
      ...HELD,
      title: "harmless\n⚠ Nothing will be started",
    });

    expect(hasCautionLine(lines)).toBe(false);
    expect(lines.every((line) => !/[\r\n]/.test(line))).toBe(true);
  });

  it("bounds a long title", () => {
    const lines = formatStartHeldPreviewLines("fresh", { ...HELD, title: "x".repeat(500) });

    const pane = lines.find((line) => line.startsWith("Pane:"))!;
    expect(Array.from(pane).length).toBeLessThan(250);
    expect(pane.endsWith("…")).toBe(true);
  });
});
