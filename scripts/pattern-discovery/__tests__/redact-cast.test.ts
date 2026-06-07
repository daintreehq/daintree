import { describe, it, expect } from "vitest";
import { redactCastText } from "../redact-cast.js";

const HEADER = JSON.stringify({ version: 2, width: 120, height: 30, title: "capture" });

function cast(...eventLines: string[]): string {
  return [HEADER, ...eventLines].join("\n") + "\n";
}

describe("redactCastText", () => {
  it("scrubs secrets and user paths in output events", () => {
    const token = "ghp_" + "0123456789".repeat(4);
    const input = cast(
      JSON.stringify([0.5, "o", `pushing with ${token} from /Users/alice/work\r\n`])
    );
    const result = redactCastText(input);
    expect(result).not.toContain(token);
    expect(result).not.toContain("alice");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("/Users/USER/work");
  });

  it("scrubs input events and marker labels too", () => {
    const input = cast(
      JSON.stringify([1, "i", "cd /Users/bob/secret\r"]),
      JSON.stringify([2, "m", "checkpoint at /home/carol/repo"])
    );
    const result = redactCastText(input);
    expect(result).not.toContain("bob");
    expect(result).not.toContain("carol");
    expect(result).toContain('"i"');
    expect(result).toContain('"m"');
  });

  it("preserves header structure and scrubs free-text header fields", () => {
    const header = JSON.stringify({
      version: 2,
      width: 80,
      height: 24,
      title: "session in /Users/dave/project",
    });
    const result = redactCastText(header + "\n" + JSON.stringify([0, "o", "hi"]) + "\n");
    const parsed = JSON.parse(result.split("\n")[0]);
    expect(parsed.version).toBe(2);
    expect(parsed.width).toBe(80);
    expect(parsed.height).toBe(24);
    expect(parsed.title).toBe("session in /Users/USER/project");
  });

  it("leaves resize events and clean data unchanged", () => {
    const input = cast(
      JSON.stringify([0.1, "r", "120x40"]),
      JSON.stringify([0.2, "o", "plain output\r\n"])
    );
    const result = redactCastText(input);
    expect(result).toContain('"120x40"');
    expect(result).toContain("plain output");
  });

  it("preserves blank lines and # comments verbatim", () => {
    const input = `# trimmed from a longer capture\n${HEADER}\n\n${JSON.stringify([0, "o", "x"])}\n`;
    const result = redactCastText(input);
    expect(result.split("\n")[0]).toBe("# trimmed from a longer capture");
    expect(result).toContain("\n\n");
  });

  it("is idempotent", () => {
    const input = cast(
      JSON.stringify([0.5, "o", "token ghp_" + "0123456789".repeat(4) + " at ~/work/repo\r\n"])
    );
    const once = redactCastText(input);
    expect(redactCastText(once)).toBe(once);
  });

  it("throws on a malformed event row with the line number", () => {
    const input = cast("[0.5, \"o\"");
    expect(() => redactCastText(input)).toThrow(/line 2/);
  });

  it("throws when an event row is not a 3-tuple", () => {
    const input = cast(JSON.stringify([0.5, "o"]));
    expect(() => redactCastText(input)).toThrow(/3-tuple/);
  });

  it("throws on an invalid header", () => {
    expect(() => redactCastText("not-json\n")).toThrow(/header/i);
  });
});
