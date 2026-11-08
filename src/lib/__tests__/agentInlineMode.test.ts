import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@shared/config/agentRegistry";

const { getEffectiveAgentConfigMock } = vi.hoisted(() => ({
  getEffectiveAgentConfigMock: vi.fn<(agentId: string) => Partial<AgentConfig> | undefined>(),
}));

vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentConfig: getEffectiveAgentConfigMock,
}));

import { getAgentInlineSupport } from "../agentInlineMode";

function declare(capabilities: AgentConfig["capabilities"]) {
  getEffectiveAgentConfigMock.mockReturnValue({ capabilities });
}

describe("getAgentInlineSupport", () => {
  beforeEach(() => {
    getEffectiveAgentConfigMock.mockReset();
  });

  it("supports inline mode when the agent declares a flag for it", () => {
    declare({ inlineModeFlag: "--inline" });
    expect(getAgentInlineSupport("a")).toEqual({ supported: true });
  });

  it("supports inline mode when the agent declares launch environment for it", () => {
    declare({ inlineModeEnv: { INLINE: "1" } });
    expect(getAgentInlineSupport("a")).toEqual({ supported: true });
  });

  it("carries the command that switches the CLI back, and counts it as support", () => {
    declare({ inlineModeCommand: "/inline" });
    expect(getAgentInlineSupport("a")).toEqual({ supported: true, command: "/inline" });
  });

  it("does not support inline mode for an agent that declares nothing", () => {
    declare({ scrollback: 1000 });
    expect(getAgentInlineSupport("a")).toEqual({ supported: false });
  });

  it("does not read stripping the alternate screen as having an inline mode", () => {
    declare({ blockAltScreen: true });
    expect(getAgentInlineSupport("a")).toEqual({ supported: false });
  });

  it("does not support inline mode for an agent with no capabilities, or an unknown one", () => {
    getEffectiveAgentConfigMock.mockReturnValue({});
    expect(getAgentInlineSupport("a")).toEqual({ supported: false });

    getEffectiveAgentConfigMock.mockReturnValue(undefined);
    expect(getAgentInlineSupport("unknown")).toEqual({ supported: false });
  });

  it("looks the agent up by the id it was given", () => {
    declare({ inlineModeFlag: "--inline" });
    getAgentInlineSupport("some-agent");
    expect(getEffectiveAgentConfigMock).toHaveBeenCalledWith("some-agent");
  });
});
