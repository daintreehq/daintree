// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useRestartAccountChoices } from "../RestartOnAccount";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { AgentSettings } from "@shared/types";

const ACCOUNTS = [
  { id: "company", name: "Company", configDir: "/Users/me/.codex-company" },
  { id: "lab", name: "Lab", configDir: "/Users/me/.codex-lab" },
];

function withAccounts(agentId: string, accounts: unknown[]): void {
  useAgentSettingsStore.setState({
    settings: { agents: { [agentId]: { accounts } } } as unknown as AgentSettings,
  });
}

afterEach(() => {
  cleanup();
  useAgentSettingsStore.setState({ settings: null });
});

describe("useRestartAccountChoices (#16040)", () => {
  it("offers every other account and the default login", () => {
    withAccounts("codex", ACCOUNTS);
    const { result } = renderHook(() => useRestartAccountChoices("codex", "company"));
    expect(result.current).toEqual([
      { id: null, name: "Default login" },
      { id: "lab", name: "Lab" },
    ]);
  });

  it("leaves the default login out for a pane already on it", () => {
    withAccounts("codex", ACCOUNTS);
    const { result } = renderHook(() => useRestartAccountChoices("codex", undefined));
    expect(result.current.map((choice) => choice.id)).toEqual(["company", "lab"]);
  });

  it("offers nothing when the agent has no saved account, or none it can choose", () => {
    withAccounts("codex", []);
    expect(renderHook(() => useRestartAccountChoices("codex", undefined)).result.current).toEqual(
      []
    );
    withAccounts("cursor", ACCOUNTS);
    expect(renderHook(() => useRestartAccountChoices("cursor", undefined)).result.current).toEqual(
      []
    );
  });
});
