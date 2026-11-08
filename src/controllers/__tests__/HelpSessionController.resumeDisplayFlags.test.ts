// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { withResumeDisplayChoices } from "../HelpSessionController";
import { setAgentSettingsEntryAccessor } from "@/store/storeAccessors";
import type { AgentSettingsEntry } from "@shared/types";

function configure(entry: AgentSettingsEntry | undefined) {
  setAgentSettingsEntryAccessor(() => entry);
}

describe("withResumeDisplayChoices (#14186)", () => {
  afterEach(() => configure(undefined));

  it("injects Codex's inline flag into the empty default flag list", () => {
    configure(undefined);
    expect(withResumeDisplayChoices([], "codex")).toContain("--no-alt-screen");
  });

  it("keeps the inline flag when an older build stored an alt-screen choice (#16356)", () => {
    configure({ inlineMode: "off" });
    expect(withResumeDisplayChoices([], "codex")).toContain("--no-alt-screen");
  });

  it("rewrites a saved --fullscreen to the inline flag (#16356)", () => {
    configure(undefined);
    expect(withResumeDisplayChoices(["--fullscreen", "--model", "x"], "grok")).toEqual([
      "--no-alt-screen",
      "--model",
      "x",
    ]);
  });

  it("never doubles a flag that is already present", () => {
    configure(undefined);
    const flags = withResumeDisplayChoices(["--no-alt-screen", "--model", "x"], "codex");
    expect(flags.filter((f) => f === "--no-alt-screen")).toHaveLength(1);
    expect(flags).toEqual(expect.arrayContaining(["--model", "x"]));
  });

  it("leaves an agent without an inline capability untouched", () => {
    configure(undefined);
    expect(withResumeDisplayChoices(["--model", "x"], "claude")).toEqual(["--model", "x"]);
  });
});
