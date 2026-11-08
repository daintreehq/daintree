// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ClaudeUsageAccount,
  ClaudeUsageReading,
  CodexQuotaProfile,
  CodexQuotaResult,
} from "@shared/types/ipc/agentQuota";

// Most cases are about one profile's reading, so these answer with the default
// profile alone; `readProfiles` takes over when a case needs several.
const readQuota = vi.hoisted(() => vi.fn<() => Promise<CodexQuotaResult>>());
const refreshQuota = vi.hoisted(() => vi.fn<() => Promise<CodexQuotaResult>>());
const readProfiles = vi.hoisted(() => vi.fn<() => Promise<CodexQuotaProfile[]> | undefined>());
const clock = vi.hoisted(() => ({ now: 0 }));

vi.mock("@/clients/codexClient", () => {
  const alone = (result: CodexQuotaResult): CodexQuotaProfile[] => [
    { key: "default", isDefault: true, presetNames: [], result },
  ];
  return {
    codexClient: {
      readQuota: () => readProfiles() ?? readQuota().then(alone),
      refreshQuota: () => refreshQuota().then(alone),
    },
  };
});
const readUsage = vi.hoisted(() => vi.fn<() => Promise<ClaudeUsageAccount[]>>());
vi.mock("@/clients/claudeClient", () => ({ claudeClient: { readUsage: () => readUsage() } }));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteClock: () => clock.now,
}));

import { AgentQuotaSection, windowLabel } from "../AgentQuotaSection";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import type { AgentSettings } from "@shared/types";

const NOW = 1_700_000_000_000;

function meters() {
  return Array.from(document.querySelectorAll('[role="meter"]'));
}

async function renderFor(agentId: string) {
  render(<AgentQuotaSection agentId={agentId} />);
  await act(async () => {});
}

beforeEach(() => {
  clock.now = NOW;
  readQuota.mockReset();
  refreshQuota.mockReset();
  readProfiles.mockReset();
  readUsage.mockReset();
  readUsage.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  useAgentSettingsStore.setState({ settings: null });
  useProjectPresetsStore.getState().reset();
});

describe("AgentQuotaSection (#12797)", () => {
  it("says no Claude usage has been seen yet, and never asks Codex", async () => {
    await renderFor("claude");
    expect(screen.getByText("No usage seen yet")).toBeTruthy();
    expect(document.body.textContent).toContain("as a limit approaches");
    expect(document.body.textContent).toContain("View usage");
    expect(readQuota).not.toHaveBeenCalled();
    expect(meters()).toHaveLength(0);
  });

  it("renders nothing for an agent with no quota story", async () => {
    await renderFor("gemini");
    expect(document.body.textContent).toBe("");
    expect(readQuota).not.toHaveBeenCalled();
  });

  it("shows each Codex window as a meter with its percentage and reset", async () => {
    readQuota.mockResolvedValue({
      status: "ok",
      planType: "plus",
      fetchedAt: NOW,
      windows: [
        { usedPercent: 42.4, windowDurationMins: 300, resetsAt: NOW + 3_600_000 },
        { usedPercent: 7, windowDurationMins: 10080, resetsAt: null },
      ],
    });
    await renderFor("codex");

    expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["42", "7"]);
    expect(screen.getByText("5-hour limit")).toBeTruthy();
    expect(screen.getByText("Weekly limit")).toBeTruthy();
    expect(screen.getByText("Reset time not reported")).toBeTruthy();
    expect(screen.getByText("Current reading")).toBeTruthy();
  });

  it("shows unavailable, with no meter, when Codex reports no quota", async () => {
    readQuota.mockResolvedValue({ status: "unavailable", reason: "read-failed", fetchedAt: NOW });
    await renderFor("codex");

    expect(screen.getByText("Quota unavailable")).toBeTruthy();
    expect(meters()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("0%");
  });

  it("treats a rejected IPC read as unavailable rather than zero", async () => {
    readQuota.mockRejectedValue(new Error("ipc gone"));
    await renderFor("codex");

    expect(screen.getByText("Quota unavailable")).toBeTruthy();
    expect(meters()).toHaveLength(0);
  });

  it("marks an old reading stale instead of presenting it as current", async () => {
    readQuota.mockResolvedValue({
      status: "ok",
      planType: null,
      fetchedAt: NOW - 10 * 60_000,
      windows: [{ usedPercent: 50, windowDurationMins: 300, resetsAt: NOW - 1 }],
    });
    await renderFor("codex");

    expect(screen.getByText("Stale reading")).toBeTruthy();
    expect(meters()[0]?.getAttribute("aria-valuetext")).toBe("50% used, stale");
    expect(screen.getByText("Reset time has passed. Waiting for a new reading.")).toBeTruthy();
  });
});

describe("AgentQuotaSection refresh (#12797)", () => {
  it("marks a fresh reading stale once one of its windows has reset", async () => {
    readQuota.mockResolvedValue({
      status: "ok",
      planType: null,
      fetchedAt: NOW,
      windows: [{ usedPercent: 50, windowDurationMins: 300, resetsAt: NOW - 1 }],
    });
    await renderFor("codex");
    expect(screen.getByText("Stale reading")).toBeTruthy();
    expect(screen.queryByText("Current reading")).toBeNull();
  });

  it("renders two windows of the same duration without dropping either", async () => {
    readQuota.mockResolvedValue({
      status: "ok",
      planType: null,
      fetchedAt: NOW,
      windows: [
        { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
        { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
      ],
    });
    await renderFor("codex");
    expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["10", "20"]);
  });

  it("reads again on Retry", async () => {
    readQuota.mockResolvedValueOnce({ status: "unavailable", reason: "timeout", fetchedAt: NOW });
    await renderFor("codex");
    refreshQuota.mockResolvedValueOnce({
      status: "ok",
      planType: null,
      fetchedAt: NOW,
      windows: [{ usedPercent: 30, windowDurationMins: 300, resetsAt: null }],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    // Retry goes past main's cache; the poll doesn't.
    expect(readQuota).toHaveBeenCalledTimes(1);
    expect(refreshQuota).toHaveBeenCalledTimes(1);
    expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["30"]);
  });

  it("keeps the last good reading when a later refresh fails, and lets it age", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      readQuota.mockResolvedValueOnce({
        status: "ok",
        planType: null,
        fetchedAt: NOW,
        windows: [{ usedPercent: 60, windowDurationMins: 300, resetsAt: null }],
      });
      const view = render(<AgentQuotaSection agentId="codex" />);
      await act(async () => {});
      readQuota.mockResolvedValue({ status: "unavailable", reason: "read-failed", fetchedAt: NOW });

      clock.now = NOW + 5 * 60_000;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      // The real minute clock re-renders on its own tick; the mock needs a nudge.
      view.rerender(<AgentQuotaSection agentId="codex" />);

      expect(readQuota).toHaveBeenCalledTimes(2);
      expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["60"]);
      expect(screen.getByText("Stale reading")).toBeTruthy();
      expect(screen.queryByText("Quota unavailable")).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});

describe("AgentQuotaSection profiles (#13686)", () => {
  const reading = (usedPercent: number): CodexQuotaResult => ({
    status: "ok",
    planType: null,
    fetchedAt: NOW,
    windows: [{ usedPercent, windowDurationMins: 300, resetsAt: null }],
  });

  function labels() {
    return Array.from(document.querySelectorAll('[role="meter"]')).map((m) =>
      m.getAttribute("aria-label")
    );
  }

  it("names one group per profile and scopes each meter to it", async () => {
    readProfiles.mockResolvedValue([
      { key: "a", isDefault: true, presetNames: ["Personal"], result: reading(10) },
      { key: "b", isDefault: false, presetNames: ["Work", "Work review"], result: reading(80) },
    ]);
    await renderFor("codex");

    expect(screen.getByText("Default profile · Personal")).toBeTruthy();
    expect(screen.getByText("Work, Work review")).toBeTruthy();
    expect(labels()).toEqual([
      "Default profile · Personal 5-hour limit used",
      "Work, Work review 5-hour limit used",
    ]);
    expect(document.body.textContent).toContain("for each CODEX_HOME your presets use");
    expect(document.body.textContent).not.toContain("the signed-in account");
  });

  it("leaves a lone profile unnamed, as before presets were read", async () => {
    readQuota.mockResolvedValue(reading(10));
    await renderFor("codex");

    expect(screen.queryByText("Default profile")).toBeNull();
    expect(labels()).toEqual(["5-hour limit used"]);
    expect(document.body.textContent).toContain("the signed-in account");
  });

  it("shows a preset's missing home beside the default's reading", async () => {
    readProfiles.mockResolvedValue([
      { key: "a", isDefault: true, presetNames: [], result: reading(10) },
      {
        key: "b",
        isDefault: false,
        presetNames: ["Second"],
        result: { status: "unavailable", reason: "home-missing", fetchedAt: NOW },
      },
    ]);
    await renderFor("codex");

    expect(meters()).toHaveLength(1);
    expect(screen.getByText("Quota unavailable")).toBeTruthy();
    expect(document.body.textContent).toContain("isn't a folder Daintree can open");
  });

  it.each([
    ["home-missing", true, "The CODEX_HOME in Codex's environment variables isn't a folder"],
    ["home-not-absolute", true, "The CODEX_HOME in Codex's environment variables isn't a full"],
    ["home-missing", false, "This preset's CODEX_HOME isn't a folder"],
    ["home-not-absolute", false, "This preset's CODEX_HOME isn't a full"],
  ] as const)(
    "words a %s home for whoever set it, default %s (#15047)",
    async (reason, isDefault, copy) => {
      readProfiles.mockResolvedValue([
        {
          key: "a",
          isDefault,
          presetNames: isDefault ? [] : ["Second"],
          result: { status: "unavailable", reason, fetchedAt: NOW },
        },
      ]);
      await renderFor("codex");

      expect(document.body.textContent).toContain(copy);
      expect(document.body.textContent).not.toContain(
        isDefault ? "This preset's" : "Codex's environment variables"
      );
    }
  );

  it("lets a batch that outlasts the poll interval finish instead of discarding it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let resolve!: (profiles: CodexQuotaProfile[]) => void;
      readProfiles.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      render(<AgentQuotaSection agentId="codex" />);
      await act(async () => {
        vi.advanceTimersByTime(120_000);
      });
      expect(readProfiles).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolve([{ key: "a", isDefault: true, presetNames: [], result: reading(40) }]);
      });
      expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["40"]);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("never carries a last good reading over to a different profile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      readProfiles.mockResolvedValueOnce([
        { key: "a", isDefault: true, presetNames: [], result: reading(60) },
      ]);
      render(<AgentQuotaSection agentId="codex" />);
      await act(async () => {});
      readProfiles.mockResolvedValue([
        {
          key: "a",
          isDefault: true,
          presetNames: [],
          result: { status: "unavailable", reason: "read-failed", fetchedAt: NOW },
        },
        {
          key: "b",
          isDefault: false,
          presetNames: ["Second"],
          result: { status: "unavailable", reason: "read-failed", fetchedAt: NOW },
        },
      ]);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      // "a" keeps its reading; "b" never had one, so it says so.
      expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["60"]);
      expect(screen.getAllByText("Quota unavailable")).toHaveLength(1);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});

describe("AgentQuotaSection project presets (#15047)", () => {
  const project = (id: string, name: string, env?: Record<string, string>) => ({ id, name, env });

  function disclosure() {
    return screen.queryByText("Project presets not included")?.closest("div")?.parentElement
      ?.textContent;
  }

  beforeEach(() => {
    readQuota.mockResolvedValue({ status: "unavailable", reason: "read-failed", fetchedAt: NOW });
  });

  it("names only the project presets that launch with a home of their own", async () => {
    useProjectPresetsStore.getState().setPresetsByAgent("p1", {
      codex: [
        project("team", "Team account", { CODEX_HOME: "/Users/me/.codex-team" }),
        project("lower", "Lower", { codex_home: "/Users/me/.codex-lower" }),
        // Empty still replaces the default, with Codex's own ~/.codex.
        project("blank", "Blank", { CODEX_HOME: "" }),
        project("plain", "Plain", { OTHER: "1" }),
        project("mine", "Shadowed", { CODEX_HOME: "/Users/me/.codex-x" }),
      ],
      claude: [project("other", "Other agent", { CODEX_HOME: "/Users/me/.codex-y" })],
    });
    // A custom preset with the same id is the one that launches, and main reads its home.
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          codex: { customPresets: [project("mine", "Mine", { CODEX_HOME: "/Users/me/.codex-m" })] },
        },
      } as AgentSettings,
    });
    await renderFor("codex");

    expect(disclosure()).toContain("Team account, Lower, and Blank set their own CODEX_HOME");
    expect(disclosure()).toContain("they're left out of the profiles above.");
    for (const name of ["Plain", "Shadowed", "Mine", "Other agent"]) {
      expect(disclosure()).not.toContain(name);
    }
  });

  it("words a lone preset in the singular", async () => {
    useProjectPresetsStore.getState().setPresetsByAgent("p1", {
      codex: [project("a", "Work", { CODEX_HOME: "/a" })],
    });
    await renderFor("codex");

    expect(disclosure()).toContain("Work sets its own CODEX_HOME");
    expect(disclosure()).toContain("it's left out of the profiles above.");
  });

  it("says nothing when no project preset names a home", async () => {
    useProjectPresetsStore.getState().setPresetsByAgent("p1", {
      codex: [project("plain", "Plain", { OTHER: "1" })],
    });
    await renderFor("codex");

    expect(disclosure()).toBeUndefined();
  });
});

describe("windowLabel", () => {
  it("names windows by duration", () => {
    expect(windowLabel(300)).toBe("5-hour limit");
    expect(windowLabel(10080)).toBe("Weekly limit");
    expect(windowLabel(1440)).toBe("1-day limit");
    expect(windowLabel(90)).toBe("90-minute limit");
  });
});

const claudeReading = (overrides: Partial<ClaudeUsageReading> = {}): ClaudeUsageReading => ({
  window: "weekly limit",
  statement: "used",
  usedPercent: 87,
  resetsAt: NOW + 3 * 60 * 60_000,
  observedAt: NOW - 5 * 60_000,
  terminalId: "t1",
  paneTitle: "Fix tests",
  projectName: "daintree",
  ...overrides,
});

const claudeAccount = (overrides: Partial<ClaudeUsageAccount> = {}): ClaudeUsageAccount => ({
  key: "default",
  kind: "default",
  accountNames: [],
  readings: [claudeReading()],
  ...overrides,
});

describe("AgentQuotaSection for Claude Code (#16370)", () => {
  it("shows what a pane said, where and how long ago, as seen rather than live", async () => {
    readUsage.mockResolvedValue([claudeAccount()]);
    await renderFor("claude");

    expect(document.body.textContent).toContain("as your panes showed them");
    expect(document.body.textContent).toContain("Not a live account reading");
    expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["87"]);
    expect(meters()[0]?.getAttribute("aria-valuetext")).toBe("87% used, as a pane showed it");
    expect(screen.getByText("Weekly limit")).toBeTruthy();
    expect(screen.getByText("87% used")).toBeTruthy();
    const description = document.body.textContent ?? "";
    expect(description).toContain("Resets at");
    expect(description).toContain("Seen 5m ago in Fix tests (daintree)");
    expect(screen.queryByText("Stale")).toBeNull();
    // A lone default login with no accounts saved needs no group name.
    expect(screen.queryByText("Default login")).toBeNull();
  });

  it("states a bound, an approach and a hit limit in their own terms, with no meter", async () => {
    readUsage.mockResolvedValue([
      claudeAccount({
        readings: [
          claudeReading({ window: "5-hour limit", statement: "reached", usedPercent: null }),
          claudeReading({ window: "weekly limit", statement: "over", usedPercent: 90 }),
          claudeReading({ window: "Opus limit", statement: "approaching", usedPercent: null }),
        ],
      }),
    ]);
    await renderFor("claude");

    expect(screen.getByText("Limit reached")).toBeTruthy();
    expect(screen.getByText("Over 90% used")).toBeTruthy();
    expect(screen.getByText("Approaching limit")).toBeTruthy();
    expect(meters()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("10% left");
  });

  it("marks a reading stale once its reset has passed, and keeps it", async () => {
    readUsage.mockResolvedValue([
      claudeAccount({ readings: [claudeReading({ resetsAt: NOW - 1 })] }),
    ]);
    await renderFor("claude");

    expect(screen.getByText("Stale")).toBeTruthy();
    expect(meters()[0]?.getAttribute("aria-valuetext")).toBe(
      "87% used, as a pane showed it, stale"
    );
    expect(document.body.textContent).toContain("Reset time has passed");
    expect(document.body.textContent).not.toContain("Resets at");
  });

  it("leaves the reset out when the message showed none", async () => {
    readUsage.mockResolvedValue([claudeAccount({ readings: [claudeReading({ resetsAt: null })] })]);
    await renderFor("claude");

    expect(document.body.textContent).toContain("Seen 5m ago in Fix tests (daintree)");
    expect(document.body.textContent).not.toContain("Reset");
    expect(screen.queryByText("Stale")).toBeNull();
  });

  it("names a pane its host no longer knows without guessing a title", async () => {
    readUsage.mockResolvedValue([
      claudeAccount({ readings: [claudeReading({ paneTitle: null, projectName: null })] }),
    ]);
    await renderFor("claude");

    expect(document.body.textContent).toContain("Seen 5m ago in a pane that's no longer open");
  });

  it("puts each login's readings under its own name", async () => {
    readUsage.mockResolvedValue([
      claudeAccount({ readings: [claudeReading({ usedPercent: 87 })] }),
      claudeAccount({
        key: "work",
        kind: "account",
        accountNames: ["Work"],
        readings: [claudeReading({ usedPercent: 30, terminalId: "t2" })],
      }),
      claudeAccount({
        key: "unknown",
        kind: "unknown",
        readings: [claudeReading({ usedPercent: 12, terminalId: "t3" })],
      }),
    ]);
    await renderFor("claude");

    // The innermost groups: the section around them is one too.
    const groups = Array.from(document.querySelectorAll('[role="group"]')).filter(
      (group) => !group.querySelector('[role="group"]')
    );
    const byGroup = groups.map((group) => [
      group.getAttribute("aria-labelledby")
        ? document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent
        : null,
      Array.from(group.querySelectorAll('[role="meter"]')).map((m) =>
        m.getAttribute("aria-valuenow")
      ),
    ]);
    expect(byGroup).toEqual([
      ["Default login", ["87"]],
      ["Work", ["30"]],
      ["Unknown config folder", ["12"]],
    ]);
    expect(meters().map((m) => m.getAttribute("aria-label"))).toEqual([
      "Default login weekly limit used",
      "Work weekly limit used",
      "Unknown config folder weekly limit used",
    ]);
  });

  it("names a lone login's group once an account is saved", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: { claude: { accounts: [{ id: "a1", name: "Work", configDir: "/w" }] } },
      } as unknown as AgentSettings,
    });
    readUsage.mockResolvedValue([claudeAccount()]);
    await renderFor("claude");

    expect(screen.getByText("Default login")).toBeTruthy();
  });

  it("offers Retry when the read fails before anything is shown, then shows the readings", async () => {
    readUsage.mockRejectedValueOnce(new Error("ipc gone"));
    await renderFor("claude");

    expect(screen.getByText("Usage unavailable")).toBeTruthy();
    readUsage.mockResolvedValue([claudeAccount()]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    expect(screen.queryByText("Usage unavailable")).toBeNull();
    expect(meters()).toHaveLength(1);
  });
});
