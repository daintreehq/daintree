// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CodexQuotaProfile } from "@shared/types/ipc/agentQuota";

const readQuota = vi.hoisted(() => vi.fn<() => Promise<CodexQuotaProfile[]>>());
vi.mock("@/clients/codexClient", () => ({
  codexClient: { readQuota: () => readQuota(), refreshQuota: () => readQuota() },
}));
vi.mock("@/clients/claudeClient", () => ({ claudeClient: { readUsage: vi.fn(async () => []) } }));

import { useRestartAccountChoices } from "../RestartOnAccount";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { AgentAccount, AgentSettings } from "@shared/types";

const ACCOUNTS: AgentAccount[] = [
  { id: "company", name: "Company", configDir: "/Users/me/.codex-company" },
  { id: "lab", name: "Lab", configDir: "/Users/me/.codex-lab" },
];

function withAccounts(agentId: string, accounts: AgentAccount[]): void {
  const settings: AgentSettings = { agents: { [agentId]: { accounts } } };
  useAgentSettingsStore.setState({ settings });
}

function profile(patch: Partial<CodexQuotaProfile>, usedPercent: number): CodexQuotaProfile {
  return {
    key: String(usedPercent),
    isDefault: false,
    presetNames: [],
    result: {
      status: "ok",
      planType: null,
      windows: [{ usedPercent, windowDurationMins: 10080, resetsAt: null }],
      fetchedAt: Date.now(),
    },
    ...patch,
  };
}

beforeEach(() => {
  readQuota.mockReset().mockResolvedValue([]);
});

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

  it("keeps the way back to the default login for a pane on an account since removed", () => {
    withAccounts("codex", []);
    const { result } = renderHook(() => useRestartAccountChoices("codex", "company"));
    expect(result.current).toEqual([{ id: null, name: "Default login" }]);
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

describe("useRestartAccountChoices quota headroom (#16407)", () => {
  const profiles = [
    profile({ isDefault: true }, 10),
    profile({ accountIds: ["company"] }, 82),
    profile({ accountIds: ["lab"] }, 35),
  ];

  it("reads no quota while the menu is closed, and adds nothing to a choice", async () => {
    withAccounts("codex", ACCOUNTS);
    readQuota.mockResolvedValue(profiles);
    const { result } = renderHook(() => useRestartAccountChoices("codex", "company", false));
    await act(async () => {});
    expect(readQuota).not.toHaveBeenCalled();
    expect(result.current).toEqual([
      { id: null, name: "Default login" },
      { id: "lab", name: "Lab" },
    ]);
  });

  it("gives each choice its own account's tightest window once open", async () => {
    withAccounts("codex", ACCOUNTS);
    readQuota.mockResolvedValue(profiles);
    const { result } = renderHook(() => useRestartAccountChoices("codex", "company", true));
    await act(async () => {});
    expect(readQuota).toHaveBeenCalledTimes(1);
    expect(result.current.map((choice) => [choice.id, choice.headroom?.text])).toEqual([
      [null, "Weekly limit 10% used"],
      ["lab", "Weekly limit 35% used"],
    ]);
  });

  it("adds nothing to an account with no reading", async () => {
    withAccounts("codex", ACCOUNTS);
    readQuota.mockResolvedValue([profiles[0]!]);
    const { result } = renderHook(() => useRestartAccountChoices("codex", "company", true));
    await act(async () => {});
    expect(result.current.find((choice) => choice.id === "lab")).toEqual({
      id: "lab",
      name: "Lab",
    });
  });

  it("gives the default login nothing when the pane's preset puts the folder elsewhere", async () => {
    const settings: AgentSettings = {
      agents: {
        codex: {
          accounts: ACCOUNTS,
          customPresets: [
            { id: "legacy", name: "Legacy", env: { CODEX_HOME: "/Users/me/.codex-legacy" } },
            { id: "plain", name: "Plain" },
          ],
        },
      },
    };
    useAgentSettingsStore.setState({ settings });
    readQuota.mockResolvedValue(profiles);
    const onLegacy = renderHook(() => useRestartAccountChoices("codex", "company", true, "legacy"));
    const onPlain = renderHook(() => useRestartAccountChoices("codex", "company", true, "plain"));
    const gone = renderHook(() => useRestartAccountChoices("codex", "company", true, "removed"));
    await act(async () => {});
    expect(onLegacy.result.current[0]?.headroom).toBeUndefined();
    expect(onLegacy.result.current[1]?.headroom?.text).toBe("Weekly limit 35% used");
    expect(onPlain.result.current[0]?.headroom?.text).toBe("Weekly limit 10% used");
    expect(gone.result.current[0]?.headroom).toBeUndefined();
  });
});
