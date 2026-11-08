import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearClaudeUsageObservations,
  recordClaudeUsageObservation,
  type ClaudeUsageRecord,
} from "../ClaudeUsageObservations.js";
import {
  defaultClaudeConfigDir,
  paneDisplayTitle,
  readClaudeUsageAccounts,
  type ClaudeUsageDeps,
  type ClaudeUsageSettings,
} from "../ClaudeUsageService.js";

const HOME_CLAUDE = path.join(os.homedir(), ".claude");
const WORK = path.join(os.tmpdir(), "daintree-16370", ".claude-work");
const LINK_TO_WORK = path.join(os.tmpdir(), "daintree-16370", "work-link");
const STRAY = path.join(os.tmpdir(), "daintree-16370", ".claude-stray");

const record = (overrides: Partial<ClaudeUsageRecord>): ClaudeUsageRecord => ({
  terminalId: "t1",
  window: "weekly limit",
  statement: "used",
  usedPercent: 80,
  resetsAt: 5_000,
  observedAt: 1_000,
  configDir: HOME_CLAUDE,
  ...overrides,
});

const workAccount = { id: "acct-work", name: "Work", configDir: WORK };

function deps(overrides: Partial<ClaudeUsageDeps> = {}): ClaudeUsageDeps {
  return {
    readSettings: async () => ({ claude: { accounts: [workAccount] }, globalEnv: undefined }),
    describePane: async (terminalId) => ({ title: `Pane ${terminalId}`, projectName: "daintree" }),
    // The link is the work folder under another name.
    canonicalKey: async (dir) => (dir === LINK_TO_WORK ? WORK : dir),
    processEnv: {},
    // The probe saw a login shell that exports no folder.
    readShellObservation: () => ({ shell: "/bin/zsh", env: {} }),
    ...overrides,
  };
}

describe("readClaudeUsageAccounts (#16370)", () => {
  afterEach(() => clearClaudeUsageObservations());

  it("answers nothing, and asks nothing, before any pane showed a message", async () => {
    let asked = false;
    const answer = await readClaudeUsageAccounts(
      deps({
        readSettings: async () => {
          asked = true;
          return { claude: undefined, globalEnv: undefined };
        },
      })
    );
    expect(answer).toEqual([]);
    expect(asked).toBe(false);
  });

  it("files each reading under the login its pane ran on, never another's", async () => {
    recordClaudeUsageObservation(record({ terminalId: "t2", usedPercent: 30, configDir: WORK }));
    recordClaudeUsageObservation(record({ terminalId: "t1", usedPercent: 80 }));
    recordClaudeUsageObservation(record({ terminalId: "t3", usedPercent: 55, configDir: null }));
    recordClaudeUsageObservation(record({ terminalId: "t4", usedPercent: 12, configDir: STRAY }));

    const accounts = await readClaudeUsageAccounts(deps());

    expect(
      accounts.map((account) => [
        account.kind,
        account.accountNames,
        account.readings.map((reading) => [reading.terminalId, reading.usedPercent]),
      ])
    ).toEqual([
      ["default", [], [["t1", 80]]],
      ["account", ["Work"], [["t2", 30]]],
      ["other", [], [["t4", 12]]],
      ["unknown", [], [["t3", 55]]],
    ]);
    expect(new Set(accounts.map((account) => account.key)).size).toBe(4);
  });

  it("names the pane and its project, and never hands out a folder", async () => {
    recordClaudeUsageObservation(record({ configDir: WORK }));

    const accounts = await readClaudeUsageAccounts(deps());

    expect(accounts[0]!.readings).toEqual([
      {
        window: "weekly limit",
        statement: "used",
        usedPercent: 80,
        resetsAt: 5_000,
        observedAt: 1_000,
        terminalId: "t1",
        paneTitle: "Pane t1",
        projectName: "daintree",
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain(WORK);
    expect(accounts[0]!.key).not.toContain(path.sep);
  });

  it("keeps the reading when its pane can't be described", async () => {
    recordClaudeUsageObservation(record({ terminalId: "gone" }));
    recordClaudeUsageObservation(record({ terminalId: "broken", window: "5-hour limit" }));

    const accounts = await readClaudeUsageAccounts(
      deps({
        describePane: async (terminalId) => {
          if (terminalId === "broken") throw new Error("pty host down");
          return null;
        },
      })
    );

    expect(
      accounts[0]!.readings.map((reading) => [
        reading.window,
        reading.paneTitle,
        reading.projectName,
      ])
    ).toEqual([
      ["5-hour limit", null, null],
      ["weekly limit", null, null],
    ]);
  });

  it("matches an account saved under another spelling of its folder", async () => {
    recordClaudeUsageObservation(record({ configDir: WORK }));

    const accounts = await readClaudeUsageAccounts(
      deps({
        readSettings: async () => ({
          claude: { accounts: [{ ...workAccount, configDir: LINK_TO_WORK }] },
          globalEnv: undefined,
        }),
      })
    );

    expect(accounts.map((account) => [account.kind, account.accountNames])).toEqual([
      ["account", ["Work"]],
    ]);
  });

  it("files every pane off the folder a login shell exports as unknown, newest per limit", async () => {
    const exported = path.join(os.tmpdir(), "daintree-16370", ".claude-profile");
    const observation = { shell: "/bin/zsh", env: { CLAUDE_CONFIG_DIR: exported } };
    // The shell's profile may have moved any of these panes; their launch folders are not proof.
    recordClaudeUsageObservation(record({ terminalId: "t1", usedPercent: 10, observedAt: 3_000 }));
    recordClaudeUsageObservation(
      record({ terminalId: "t2", usedPercent: 20, observedAt: 4_000, configDir: WORK })
    );
    recordClaudeUsageObservation(
      record({ terminalId: "t3", usedPercent: 30, observedAt: 2_000, configDir: STRAY })
    );
    // A pane launched on the exported folder is on it either way.
    recordClaudeUsageObservation(
      record({ terminalId: "t4", usedPercent: 40, observedAt: 1_000, configDir: exported })
    );

    const accounts = await readClaudeUsageAccounts(
      deps({ readShellObservation: () => observation })
    );

    expect(
      accounts.map((account) => [
        account.kind,
        account.readings.map((reading) => [reading.terminalId, reading.usedPercent]),
      ])
    ).toEqual([
      ["default", [["t4", 40]]],
      // Newest of the three, though neither first nor last seen.
      ["unknown", [["t2", 20]]],
    ]);
  });

  it("files nothing as any login's when a login shell exports a folder that can't be resolved", async () => {
    recordClaudeUsageObservation(record({}));
    recordClaudeUsageObservation(record({ terminalId: "t2", configDir: WORK }));

    const accounts = await readClaudeUsageAccounts(
      deps({
        readShellObservation: () => ({ shell: "/bin/zsh", env: { CLAUDE_CONFIG_DIR: "rel" } }),
      })
    );

    expect(accounts.map((account) => account.kind)).toEqual(["unknown"]);
  });

  it("trusts each pane's launch folder when no probe has answered", async () => {
    recordClaudeUsageObservation(record({}));
    recordClaudeUsageObservation(record({ terminalId: "t2", configDir: WORK }));

    const accounts = await readClaudeUsageAccounts(deps({ readShellObservation: () => undefined }));

    expect(accounts.map((account) => account.kind)).toEqual(["default", "account"]);
  });

  it("lists a removed account's readings as another folder, not under any login", async () => {
    recordClaudeUsageObservation(record({ configDir: WORK }));

    const accounts = await readClaudeUsageAccounts(
      deps({ readSettings: async () => ({ claude: undefined, globalEnv: undefined }) })
    );

    expect(accounts.map((account) => [account.kind, account.accountNames])).toEqual([
      ["other", []],
    ]);
  });

  it("still groups by folder when settings can't be read", async () => {
    recordClaudeUsageObservation(record({}));

    const accounts = await readClaudeUsageAccounts(
      deps({ readSettings: () => Promise.reject(new Error("store gone")) })
    );

    expect(accounts.map((account) => account.kind)).toEqual(["default"]);
  });

  it("names every account a shared folder has", async () => {
    recordClaudeUsageObservation(record({ configDir: WORK }));

    const accounts = await readClaudeUsageAccounts(
      deps({
        readSettings: async () => ({
          claude: {
            accounts: [workAccount, { id: "acct-team", name: "Team", configDir: LINK_TO_WORK }],
          },
          globalEnv: undefined,
        }),
      })
    );

    expect(accounts[0]!.accountNames).toEqual(["Work", "Team"]);
  });
});

describe("defaultClaudeConfigDir (#16370)", () => {
  const settings = (overrides: Partial<ClaudeUsageSettings> = {}): ClaudeUsageSettings => ({
    claude: undefined,
    globalEnv: undefined,
    ...overrides,
  });

  it("is Claude's own folder when nothing names one", () => {
    expect(defaultClaudeConfigDir(settings(), {})).toBe(HOME_CLAUDE);
  });

  it("takes the topmost layer that names one: Claude's env, then Daintree's, then main's", () => {
    const fromMain = path.join(os.tmpdir(), "main");
    const fromGlobal = path.join(os.tmpdir(), "global");
    const fromAgent = path.join(os.tmpdir(), "agent");
    const env = { CLAUDE_CONFIG_DIR: fromMain };

    expect(defaultClaudeConfigDir(settings(), env)).toBe(fromMain);
    expect(
      defaultClaudeConfigDir(settings({ globalEnv: { CLAUDE_CONFIG_DIR: fromGlobal } }), env)
    ).toBe(fromGlobal);
    expect(
      defaultClaudeConfigDir(
        settings({
          globalEnv: { CLAUDE_CONFIG_DIR: fromGlobal },
          claude: { globalEnv: { CLAUDE_CONFIG_DIR: fromAgent } },
        }),
        env
      )
    ).toBe(fromAgent);
  });

  it("is unknown when the layer that names one names a folder that can't be resolved", () => {
    expect(
      defaultClaudeConfigDir(settings({ globalEnv: { CLAUDE_CONFIG_DIR: "relative" } }), {})
    ).toBeUndefined();
  });
});

describe("paneDisplayTitle (#16370)", () => {
  it("names the pane as its header does, with the agent's task", () => {
    expect(
      paneDisplayTitle({
        title: "Claude",
        titleMode: "default",
        lastObservedTitle: "Fix flaky tests",
        detectedAgentId: "claude",
        agentState: "working",
      })
    ).toBe("Claude: Fix flaky tests");
  });

  it("is null for a pane with nothing to call it", () => {
    expect(paneDisplayTitle({ title: "  " })).toBeNull();
    expect(paneDisplayTitle({})).toBeNull();
  });
});
