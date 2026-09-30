import { describe, expect, it } from "vitest";
import {
  appendCallerLaunchFlagsToCommand,
  readCallerLaunchFlags,
  splitCallerLaunchFlags,
} from "../callerLaunchFlags.js";

describe("splitCallerLaunchFlags", () => {
  it("splits the caller's tail off the settings-derived flags", () => {
    expect(
      splitCallerLaunchFlags(
        ["--model", "gpt-5", "-c", "model_reasoning_effort=high"],
        ["-c", "model_reasoning_effort=high"]
      )
    ).toEqual({ base: ["--model", "gpt-5"], caller: ["-c", "model_reasoning_effort=high"] });
  });

  it("keeps tokens the caller repeats from the base in the base", () => {
    expect(splitCallerLaunchFlags(["-c", "a=1", "-c", "a=1"], ["-c", "a=1"])).toEqual({
      base: ["-c", "a=1"],
      caller: ["-c", "a=1"],
    });
  });

  it("treats the whole list as settings-derived when it no longer ends with the caller flags", () => {
    const flags = ["-c", "model_reasoning_effort=high", "--yolo"];
    expect(splitCallerLaunchFlags(flags, ["-c", "model_reasoning_effort=high"])).toEqual({
      base: flags,
      caller: [],
    });
  });

  it("handles missing flags and missing caller flags", () => {
    expect(splitCallerLaunchFlags(undefined, ["--x"])).toEqual({ base: [], caller: [] });
    expect(splitCallerLaunchFlags(["--x"], undefined)).toEqual({ base: ["--x"], caller: [] });
    expect(splitCallerLaunchFlags(["--x"], [])).toEqual({ base: ["--x"], caller: [] });
  });

  it("returns fresh arrays without mutating its inputs", () => {
    const flags = ["--a", "--b"];
    const caller = ["--b"];
    const split = splitCallerLaunchFlags(flags, caller);
    split.base.push("--z");
    split.caller.push("--z");
    expect(flags).toEqual(["--a", "--b"]);
    expect(caller).toEqual(["--b"]);
  });
});

describe("readCallerLaunchFlags", () => {
  it("returns only a trusted caller tail", () => {
    expect(readCallerLaunchFlags(["--a", "--b"], ["--b"])).toEqual(["--b"]);
    expect(readCallerLaunchFlags(["--b", "--a"], ["--b"])).toEqual([]);
  });
});

describe("appendCallerLaunchFlagsToCommand", () => {
  it("passes options through and quotes values only when needed", () => {
    const quotedEffort =
      process.platform === "win32"
        ? '"model_reasoning_effort=high"'
        : "'model_reasoning_effort=high'";
    expect(
      appendCallerLaunchFlagsToCommand("codex", ["-c", "model_reasoning_effort=high", "--x"])
    ).toBe(`codex -c ${quotedEffort} --x`);
    expect(appendCallerLaunchFlagsToCommand("claude", ["--model", "sonnet"])).toBe(
      "claude --model sonnet"
    );
  });

  it("leaves the command alone when there is nothing to append", () => {
    expect(appendCallerLaunchFlagsToCommand("codex", undefined)).toBe("codex");
    expect(appendCallerLaunchFlagsToCommand("codex", ["", ""])).toBe("codex");
  });
});
