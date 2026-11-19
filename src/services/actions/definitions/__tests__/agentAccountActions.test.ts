import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext, HostApprovedTarget } from "@shared/types/actions";
import type { AgentSettings } from "@shared/types/agentSettings";
import type { AddAgentAccountRequest } from "@shared/types/ipc/agentAccounts";
import { UnactionableTargetError } from "../../unactionableTarget";

const store = vi.hoisted(() => ({
  settings: null as AgentSettings | null,
  isInitialized: true,
  initialize: vi.fn(async () => {}),
  addAccount: vi.fn(async (_request: unknown) => ({ id: "", name: "", configDir: "" })),
}));
const view = vi.hoisted(() => ({
  worktrees: new Map<string, unknown>(),
  isInitialized: true,
}));
const projectPresets = vi.hoisted(() => ({
  presetsByAgent: {} as Record<string, unknown>,
  hydratedProjectId: "proj-1" as string | null,
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: {
    getState: () => ({
      settings: store.settings,
      isInitialized: store.isInitialized,
      initialize: store.initialize,
      addAccount: store.addAccount,
    }),
  },
}));
vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: () => ({ ccrPresetsByAgent: {}, isInitialized: true }) },
}));
vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: { getState: () => projectPresets },
}));
vi.mock("@/store/createWorktreeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/createWorktreeStore")>()),
  getCurrentViewStore: () => ({ getState: () => view }),
}));

import { registerAgentActions } from "../agentActions";
import { accountRowId, accountRowTarget, planAgentAccountAdd } from "../agentAccountAdd";

function definition(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = Object.create(null);
  registerAgentActions(actions, callbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

async function run(id: string, args: unknown, extra: Partial<ActionContext> = {}) {
  const def = definition(id);
  const parsed = def.argsSchema ? def.argsSchema.parse(args) : args;
  const ctx: ActionContext = { dispatchSource: "agent", projectId: "proj-1", ...extra };
  const result = await def.run(parsed, ctx);
  // What dispatch returns: the run's answer parsed through its own schema.
  return def.resultSchema ? def.resultSchema.parse(result) : result;
}

const COMPANY = { id: "company", name: "Company", configDir: "/Users/me/.claude-company" };
const PERSONAL = { id: "personal", name: "Personal", configDir: "/Users/me/.claude-personal" };

/** The batch from the issue: six Claude accounts and two Codex ones. */
const ISSUE_BATCH = {
  accounts: [
    { agentId: "claude", name: "google:me@example.com", folder: { kind: "create" } },
    ...["two", "three", "four", "five"].map((name) => ({
      agentId: "claude",
      name,
      folder: { kind: "create" },
    })),
    {
      agentId: "claude",
      name: "Shared",
      folder: { kind: "existing", path: "/Volumes/team/.claude-shared" },
    },
    { agentId: "codex", name: "Work", folder: { kind: "create" } },
    { agentId: "codex", name: "Lab", folder: { kind: "existing", path: "/Users/me/.codex-lab" } },
  ],
};

function approved(...indexes: number[]): HostApprovedTarget[] {
  return indexes.map((index) => ({ id: accountRowId(index), observedAgentRunning: false }));
}

describe("planAgentAccountAdd (#17079)", () => {
  it("names each row's folder as main will make or use it", () => {
    const plan = planAgentAccountAdd(ISSUE_BATCH);
    if (!plan.ok) throw new Error(plan.message);

    expect(plan.rows.map((row) => [row.agentId, row.name, row.destination])).toEqual([
      ["claude", "google:me@example.com", "~/.claude-google-me-example-com"],
      ["claude", "two", "~/.claude-two"],
      ["claude", "three", "~/.claude-three"],
      ["claude", "four", "~/.claude-four"],
      ["claude", "five", "~/.claude-five"],
      ["claude", "Shared", "/Volumes/team/.claude-shared"],
      ["codex", "Work", "~/.codex-work"],
      ["codex", "Lab", "/Users/me/.codex-lab"],
    ]);
    expect(accountRowTarget(plan.rows[0]!)).toEqual({
      id: "row-0",
      name: "google:me@example.com",
      kindLabel: "Claude account",
      agentRunning: false,
      detail: "New folder ~/.claude-google-me-example-com",
    });
    expect(accountRowTarget(plan.rows[7]!).detail).toBe("Existing folder /Users/me/.codex-lab");
  });

  it("saves the name as main would, trimmed and without control characters", () => {
    const plan = planAgentAccountAdd({
      accounts: [{ agentId: "codex", name: "  Team\tBlue ", folder: { kind: "create" } }],
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.rows[0]).toMatchObject({ name: "Team Blue", destination: "~/.codex-team-blue" });
  });

  it.each([
    ["/tmp/team", "/tmp/team//"],
    ["C:\\team", "C:\\team\\"],
  ])("treats %s and %s as the same existing folder", (first, second) => {
    const plan = planAgentAccountAdd({
      accounts: [
        { agentId: "codex", name: "Team", folder: { kind: "existing", path: first } },
        { agentId: "codex", name: "Team 2", folder: { kind: "existing", path: second } },
      ],
    });
    expect(plan).toEqual({
      ok: false,
      message: "Accounts 1 and 2 name the same folder. Nothing was added.",
    });
  });

  it("keeps a trailing backslash as part of a POSIX folder's name", () => {
    const plan = planAgentAccountAdd({
      accounts: [
        { agentId: "codex", name: "Team", folder: { kind: "existing", path: "/tmp/team" } },
        { agentId: "codex", name: "Odd", folder: { kind: "existing", path: "/tmp/team\\" } },
      ],
    });
    expect(plan.ok).toBe(true);
  });

  it.each([
    [
      "an agent with no folder accounts",
      [{ agentId: "cursor", name: "Work", folder: { kind: "create" } }],
      "Account 1: cursor has no accounts to add.",
    ],
    [
      "a name a folder can't carry",
      [{ agentId: "claude", name: "!!!", folder: { kind: "create" } }],
      "letters or numbers",
    ],
    [
      "a relative existing folder",
      [{ agentId: "claude", name: "Work", folder: { kind: "existing", path: "work/.claude" } }],
      "full path",
    ],
    [
      "two rows making one folder",
      [
        { agentId: "claude", name: "Team", folder: { kind: "create" } },
        { agentId: "codex", name: "Team", folder: { kind: "create" } },
        { agentId: "claude", name: "team!", folder: { kind: "create" } },
      ],
      "Accounts 1 and 3 name the same folder.",
    ],
    [
      "a misspelt field",
      [{ agentId: "claude", name: "Work", folder: { kind: "create" }, folderPath: "/x" }],
      "Invalid accounts.",
    ],
  ])("refuses %s before anything is asked", (_label, accounts, message) => {
    const plan = planAgentAccountAdd({ accounts });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.message).toContain(message);
      expect(plan.message).toContain("Nothing was added.");
    }
  });
});

describe("agent.addAccount run (#17079)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let next = 0;
    store.addAccount.mockImplementation(async (request: unknown) => {
      const { name } = request as AddAgentAccountRequest;
      next += 1;
      return { id: `account-${next}`, name, configDir: `/Users/me/.x-${next}` };
    });
  });

  it("adds nothing when no dialog named the rows", async () => {
    await expect(run("agent.addAccount", ISSUE_BATCH)).rejects.toThrow("Nothing was added.");
    expect(store.addAccount).not.toHaveBeenCalled();
  });

  it("starts no later row once the call's time runs out mid-batch", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    store.addAccount.mockImplementation(async (request: unknown) => {
      const { name } = request as AddAgentAccountRequest;
      now += 500;
      return { id: `id-${name}`, name, configDir: "/Users/me/.x" };
    });

    const result = await run("agent.addAccount", ISSUE_BATCH, {
      hostApprovedTargets: approved(0, 1, 2),
      dispatchDeadlineAt: 2_000,
    });
    clock.mockRestore();

    const rows = (result as { accounts: Array<{ status: string }> }).accounts;
    expect(rows.slice(0, 3).map((row) => row.status)).toEqual(["added", "added", "notAttempted"]);
    expect(store.addAccount).toHaveBeenCalledTimes(2);
  });

  it("adds only the ticked rows, in order, and reports the rest as declined", async () => {
    const result = await run("agent.addAccount", ISSUE_BATCH, {
      hostApprovedTargets: approved(0, 5, 7),
    });

    expect(store.addAccount.mock.calls.map(([request]) => request)).toEqual([
      { agentId: "claude", name: "google:me@example.com", folder: { kind: "create" } },
      {
        agentId: "claude",
        name: "Shared",
        folder: { kind: "existing", path: "/Volumes/team/.claude-shared" },
      },
      { agentId: "codex", name: "Lab", folder: { kind: "existing", path: "/Users/me/.codex-lab" } },
    ]);
    const rows = (result as { accounts: Array<Record<string, unknown>> }).accounts;
    expect(rows.map((row) => row.status)).toEqual([
      "added",
      "declined",
      "declined",
      "declined",
      "declined",
      "added",
      "declined",
      "added",
    ]);
    expect(rows[7]).toEqual({
      index: 7,
      agentId: "codex",
      status: "added",
      accountId: "account-3",
      name: "Lab",
    });
    // The folders main made or used never come back to the caller.
    expect(JSON.stringify(result)).not.toContain("/Users/me");
  });

  it("keeps going past a row main refuses, and keeps the rows before it", async () => {
    store.addAccount.mockImplementation(async (request: unknown) => {
      const { name } = request as AddAgentAccountRequest;
      if (name === "three") {
        throw new Error(
          "A folder named .claude-three already exists. Use it as an existing folder, or choose another name."
        );
      }
      return { id: `id-${name}`, name, configDir: "/Users/me/.x" };
    });

    const result = await run("agent.addAccount", ISSUE_BATCH, {
      hostApprovedTargets: approved(0, 1, 2, 3, 4, 5, 6, 7),
    });

    const rows = (result as { accounts: Array<Record<string, unknown>> }).accounts;
    expect(store.addAccount).toHaveBeenCalledTimes(8);
    expect(rows.map((row) => row.status)).toEqual([
      "added",
      "added",
      "failed",
      "added",
      "added",
      "added",
      "added",
      "added",
    ]);
    expect(rows[2]?.error).toContain("A folder named .claude-three already exists");
  });

  it("starts no row once the call's time is up", async () => {
    const result = await run("agent.addAccount", ISSUE_BATCH, {
      hostApprovedTargets: approved(0, 1),
      dispatchDeadlineAt: Date.now() - 1,
    });

    expect(store.addAccount).not.toHaveBeenCalled();
    const rows = (result as { accounts: Array<{ status: string }> }).accounts;
    expect(rows.slice(0, 2).map((row) => row.status)).toEqual(["notAttempted", "notAttempted"]);
  });

  it("refuses rows it can't plan, before any add", async () => {
    await expect(
      run(
        "agent.addAccount",
        { accounts: [{ agentId: "cursor", name: "Work", folder: { kind: "create" } }] },
        { hostApprovedTargets: approved(0) }
      )
    ).rejects.toBeInstanceOf(UnactionableTargetError);
    expect(store.addAccount).not.toHaveBeenCalled();
  });
});

describe("agent.listAccounts run (#17079)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.isInitialized = true;
    view.isInitialized = true;
    projectPresets.presetsByAgent = {};
    projectPresets.hydratedProjectId = "proj-1";
    view.worktrees = new Map([
      ["wt-1", {}],
      ["wt-2", {}],
    ]);
    store.settings = {
      agents: {
        claude: {
          accounts: [COMPANY, PERSONAL],
          accountId: "personal",
          presetId: "work",
          customPresets: [{ id: "work", name: "Work", accountId: "company" }],
          worktreeAccounts: { "wt-2": null },
        },
      },
    } as unknown as AgentSettings;
  });

  it("lists each account's id, name and default, and no folder", async () => {
    const result = await run("agent.listAccounts", { agentId: "claude" });

    expect(result).toEqual({
      accounts: [
        { id: "company", name: "Company", isDefault: false },
        { id: "personal", name: "Personal", isDefault: true },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("/Users/me");
  });

  it("says which account a plain launch in the worktree uses, and what chose it", async () => {
    const pinned = await run("agent.listAccounts", { agentId: "claude", worktreeId: "wt-1" });
    expect(pinned).toMatchObject({
      worktreeLaunch: {
        accountId: "company",
        source: "preset",
        presetId: "work",
        presetsComplete: true,
      },
    });

    const cliLogin = await run("agent.listAccounts", { agentId: "claude", worktreeId: "wt-2" });
    expect(cliLogin).toMatchObject({
      worktreeLaunch: { accountId: null, source: "worktree", presetsComplete: true },
    });
  });

  // A launch waits for a preset whose inventory hasn't loaded, so the listing
  // names no account it might not use; the worktree's own pick still decides.
  it("names no account while the worktree's preset is still loading", async () => {
    projectPresets.hydratedProjectId = null;
    const settings = store.settings as unknown as {
      agents: { claude: Record<string, unknown> };
    };
    settings.agents.claude.worktreePresets = { "wt-1": "repo-team", "wt-2": "repo-team" };

    const loading = await run("agent.listAccounts", { agentId: "claude", worktreeId: "wt-1" });
    expect(loading).toMatchObject({ worktreeLaunch: { presetsComplete: false } });
    expect((loading as { worktreeLaunch: Record<string, unknown> }).worktreeLaunch).toEqual({
      presetsComplete: false,
    });

    const decided = await run("agent.listAccounts", { agentId: "claude", worktreeId: "wt-2" });
    expect(decided).toMatchObject({
      worktreeLaunch: { accountId: null, source: "worktree", presetsComplete: false },
    });

    projectPresets.presetsByAgent = { claude: [{ id: "repo-team", name: "Team" }] };
    projectPresets.hydratedProjectId = "proj-1";
    const loaded = await run("agent.listAccounts", { agentId: "claude", worktreeId: "wt-1" });
    expect(loaded).toMatchObject({
      worktreeLaunch: { accountId: "personal", source: "agentDefault", presetsComplete: true },
    });
  });

  it("refuses a worktree the view doesn't have, without echoing its id", async () => {
    const attempt = run("agent.listAccounts", { agentId: "claude", worktreeId: "/Users/me/wt-x" });
    await expect(attempt).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(attempt).rejects.not.toThrow("/Users/me");
  });

  it("refuses an unknown agent and one that signs in one way only", async () => {
    await expect(run("agent.listAccounts", { agentId: "no-such-agent" })).rejects.toBeInstanceOf(
      UnactionableTargetError
    );
    await expect(run("agent.listAccounts", { agentId: "cursor" })).rejects.toThrow(
      "signs in one way only"
    );
  });

  it("fails rather than reporting no accounts when the settings can't be read", async () => {
    store.settings = null;
    store.isInitialized = false;

    await expect(run("agent.listAccounts", { agentId: "claude" })).rejects.toThrow(
      "Couldn't read the agent settings"
    );
    expect(store.initialize).toHaveBeenCalled();
  });
});
