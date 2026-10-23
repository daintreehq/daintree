// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { withResumeDisplayChoices } from "../HelpSessionController";
import {
  setAgentSettingsEntryAccessor,
  setGlobalUseAltScreenAccessor,
} from "@/store/storeAccessors";
import type { AgentSettingsEntry } from "@shared/types";

function configure(entry: AgentSettingsEntry | undefined, globalUseAltScreen?: boolean) {
  setAgentSettingsEntryAccessor(() => entry);
  setGlobalUseAltScreenAccessor(() => globalUseAltScreen);
}

describe("withResumeDisplayChoices (#14186)", () => {
  afterEach(() => configure(undefined));

  it("injects Codex's inline flag into the empty default flag list", () => {
    configure(undefined);
    expect(withResumeDisplayChoices([], "codex")).toContain("--no-alt-screen");
  });

  it("omits the inline flag when the global alt-screen switch is on", () => {
    configure(undefined, true);
    expect(withResumeDisplayChoices([], "codex")).not.toContain("--no-alt-screen");
  });

  it("omits the inline flag when the agent's own choice is off", () => {
    configure({ inlineMode: "off" } as AgentSettingsEntry);
    expect(withResumeDisplayChoices([], "codex")).not.toContain("--no-alt-screen");
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
