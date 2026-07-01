import { describe, expect, it } from "vitest";
import { prepareExitSnapshot, EXIT_SNAPSHOT_MAX_BYTES } from "../exitSnapshot.js";

describe("prepareExitSnapshot", () => {
  it("returns empty string for empty input", () => {
    expect(prepareExitSnapshot("")).toBe("");
  });

  it("passes through short clean text unchanged", () => {
    const text = "npm run build\nBuild succeeded in 3.2s\n";
    expect(prepareExitSnapshot(text)).toBe(text);
  });

  it("scrubs recognizable secrets before persisting", () => {
    // `sk-ant-` pattern requires 90+ trailing chars (see secretScrubber PATTERNS).
    const token = "sk-ant-api03-" + "A".repeat(95);
    const out = prepareExitSnapshot(`Using key ${token} to authenticate`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("scrubs BEFORE truncating so a secret straddling the byte cap can't leak", () => {
    // Bury a secret near the very end, then pad the front past the cap so the
    // tail-truncation must run over a region that originally held the token.
    const token = "ghp_" + "b".repeat(40);
    const filler = "x".repeat(EXIT_SNAPSHOT_MAX_BYTES * 2);
    const out = prepareExitSnapshot(`${filler}\n${token}\n${filler}`);
    // If truncation ran first, a partial `ghp_bbbb…` fragment could survive.
    expect(out).not.toMatch(/ghp_b+/);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(EXIT_SNAPSHOT_MAX_BYTES);
  });

  it("caps output at the byte budget and keeps the tail", () => {
    const head = "H".repeat(EXIT_SNAPSHOT_MAX_BYTES);
    const tail = "TAIL_MARKER_END";
    const out = prepareExitSnapshot(head + tail);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(EXIT_SNAPSHOT_MAX_BYTES);
    // The most-recent output (the tail) is what we keep.
    expect(out.endsWith(tail)).toBe(true);
  });

  it("never splits a multi-byte code point at the cap boundary", () => {
    // Fill with 4-byte emoji so the cut lands mid-character unless guarded.
    const emoji = "😀"; // 4 UTF-8 bytes, 2 UTF-16 units
    const count = Math.ceil(EXIT_SNAPSHOT_MAX_BYTES / 4) + 50;
    const out = prepareExitSnapshot(emoji.repeat(count));
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(EXIT_SNAPSHOT_MAX_BYTES);
    // A split surrogate/continuation byte would round-trip to U+FFFD.
    expect(out).not.toContain("�");
    // The kept portion must be a whole number of emoji.
    expect([...out].every((ch) => ch === emoji)).toBe(true);
  });
});
