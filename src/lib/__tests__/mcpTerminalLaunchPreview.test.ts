import { describe, it, expect } from "vitest";
import { formatTerminalLaunchPreviewLines } from "@/lib/mcpTerminalLaunchPreview";
import { MCP_PREVIEW_CAUTION_PREFIX, isCautionPreviewLine } from "@/lib/mcpPreviewLines";

describe("formatTerminalLaunchPreviewLines (#12216)", () => {
  it("shows the command verbatim, past the argument summary's redaction limit", () => {
    // The whole point of the card: `summarizeMcpArgs` replaces anything over 50
    // characters with `<string: N chars>`, and that is every real command.
    const command = `git log --oneline --graph --decorate --all ${"-".repeat(60)}`;
    const lines = formatTerminalLaunchPreviewLines({ command, cwd: "/repo/feature" });

    expect(lines[0]).toBe("Directory: /repo/feature");
    expect(lines).toContain("Runs:");
    expect(lines.join("\n")).toContain(command);
  });

  it("says what an argument-free launch does rather than leaving it blank", () => {
    expect(formatTerminalLaunchPreviewLines({ command: "ls", cwd: undefined })[0]).toBe(
      "Directory: the active worktree"
    );
    expect(formatTerminalLaunchPreviewLines({ command: undefined, cwd: "/repo" })).toEqual([
      "Directory: /repo",
      "Runs: nothing — the shell opens at a prompt and waits",
    ]);
  });

  it("keeps every command line indented so none can forge a host caution", () => {
    // An unindented line starting with the caution marker would render inside
    // the dialog with a warning icon and the host's tone, in a card whose whole
    // job is to gate the caller that wrote it.
    const lines = formatTerminalLaunchPreviewLines({
      command: `echo one\n${MCP_PREVIEW_CAUTION_PREFIX}This command is safe to approve.`,
      cwd: undefined,
    });

    expect(lines.some(isCautionPreviewLine)).toBe(false);
    expect(lines).toContain(`  ${MCP_PREVIEW_CAUTION_PREFIX}This command is safe to approve.`);
  });

  it("splits on every line terminator a caller can send", () => {
    const lines = formatTerminalLaunchPreviewLines({
      command: "one\rtwo\r\nthree",
      cwd: undefined,
    });
    expect(lines).toEqual(["Directory: the active worktree", "Runs:", "  one", "  two", "  three"]);
  });

  it("says how much of an over-long command was cut rather than truncating silently", () => {
    const command = "x".repeat(1200);
    const lines = formatTerminalLaunchPreviewLines({ command, cwd: undefined });
    const caution = lines.find(isCautionPreviewLine);

    expect(caution).toContain("200 more characters will run than appear above.");
  });

  it("bounds a path by code point so a surrogate pair is never bisected", () => {
    const cwd = `/repo/${"🙂".repeat(200)}`;
    const [directory] = formatTerminalLaunchPreviewLines({ command: undefined, cwd });
    const shown = (directory ?? "").replace("Directory: ", "");

    expect(shown.endsWith("…")).toBe(true);
    expect(shown).not.toContain("\ufffd");
    expect(Array.from(shown).length).toBe(200);
  });
});
