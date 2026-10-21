import { describe, expect, it } from "vitest";
import { formatShellArgs, parseShellArgs } from "../shellArgs.js";

describe("shellArgs", () => {
  it.each([
    [["-l"]],
    [["-c", "printf hello", "", "two words"]],
    [[""]],
    [["it's"]],
    [['say "hi"']],
    [[`it's "both"`, "'''", '"']],
    [["C:\\Program Files\\Git\\bin", "C:\\tools"]],
    [["tab\there", "new\nline"]],
  ])("round-trips %j", (args) => {
    expect(parseShellArgs(formatShellArgs(args))).toEqual(args);
  });

  it("leaves plain arguments unquoted", () => {
    expect(formatShellArgs(["-l", "--login", "C:\\tools"])).toBe("-l --login C:\\tools");
  });

  it("splits on any whitespace and ignores surrounding blanks", () => {
    expect(parseShellArgs("  -l \t --login  ")).toEqual(["-l", "--login"]);
    expect(parseShellArgs("   ")).toEqual([]);
  });

  it("joins adjacent quoted and unquoted parts into one argument", () => {
    expect(parseShellArgs(`--name="a b"'c'd`)).toEqual(["--name=a bcd"]);
  });

  it("keeps backslashes literal outside and inside quotes", () => {
    expect(parseShellArgs(`C:\\a\\b "C:\\c d\\"`)).toEqual(["C:\\a\\b", "C:\\c d\\"]);
  });

  it("treats an unterminated quote as running to the end", () => {
    expect(parseShellArgs(`-c "echo hi`)).toEqual(["-c", "echo hi"]);
  });
});
