import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runSession = vi.hoisted(() => vi.fn());
const agentSettings = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("../../../store.js", () => ({
  store: { get: (key: string) => (key === "agentSettings" ? agentSettings.value : undefined) },
}));

vi.mock("../CodexAppServerClient.js", async () => {
  const actual = await vi.importActual<typeof import("../CodexAppServerClient.js")>(
    "../CodexAppServerClient.js"
  );
  return { ...actual, runCodexAppServerSession: runSession };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerError } from "../CodexAppServerClient.js";
import { canonicalCodexHomeKey } from "../CodexQuotaProfiles.js";
import {
  normalizeCodexRateLimits,
  readCodexHomeLimitEvidence,
  readCodexQuota,
  readCodexQuotaForHomes,
  readCodexQuotaProfiles,
  refreshCodexQuota,
  refreshCodexQuotaProfiles,
  resetCodexQuotaCacheForTests,
  toCodexLimitEvidence,
} from "../CodexQuotaService.js";

type Call = (method: string, params?: unknown) => Promise<unknown>;

function respondWith(reply: () => unknown) {
  runSession.mockImplementation(async (run: (call: Call) => Promise<unknown>) =>
    run(async (method) => {
      if (method !== "account/rateLimits/read") throw new Error(`unexpected ${method}`);
      return reply();
    })
  );
}

const FIVE_HOURS = { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_700_000_000 };
const WEEK = { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1_700_500_000 };

describe("normalizeCodexRateLimits", () => {
  it("converts reset seconds to ms and orders windows by duration, not slot", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: WEEK, secondary: FIVE_HOURS, planType: "plus" } },
      5
    );
    expect(result).toEqual({
      status: "ok",
      planType: "plus",
      fetchedAt: 5,
      windows: [
        { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_700_000_000_000 },
        { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1_700_500_000_000 },
      ],
    });
  });

  it("keeps a lone window when the other is null", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: null, secondary: WEEK, planType: null } },
      1
    );
    expect(result).toMatchObject({ status: "ok", planType: null });
    expect(result.status === "ok" && result.windows).toHaveLength(1);
  });

  it("reports a real 0% as 0, and a missing reset as null", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } },
      1
    );
    expect(result.status === "ok" && result.windows[0]).toEqual({
      usedPercent: 0,
      windowDurationMins: 300,
      resetsAt: null,
    });
  });

  it("never fabricates a zero when no window was sent", () => {
    expect(normalizeCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, 1)).toEqual(
      { status: "unavailable", reason: "no-windows", fetchedAt: 1 }
    );
  });

  it.each([
    ["a non-object", "nope"],
    ["no rateLimits", {}],
    ["a window without a percentage", { rateLimits: { primary: { windowDurationMins: 300 } } }],
    [
      "a window with a non-positive duration",
      { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 0 } } },
    ],
    [
      "a fractional duration",
      { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 90.5 } } },
    ],
    [
      "a NaN percentage",
      { rateLimits: { primary: { usedPercent: Number.NaN, windowDurationMins: 300 } } },
    ],
    [
      "one unreadable window beside a good one",
      { rateLimits: { primary: FIVE_HOURS, secondary: { usedPercent: "x" } } },
    ],
  ])("treats %s as unsupported", (_label, raw) => {
    expect(normalizeCodexRateLimits(raw, 1)).toMatchObject({
      status: "unavailable",
      reason: "unsupported-response",
    });
  });

  it("caps a reported overage at 100%", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 130, windowDurationMins: 300 } } },
      1
    );
    expect(result.status === "ok" && result.windows[0]?.usedPercent).toBe(100);
  });
});

describe("readCodexQuota", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    runSession.mockReset();
    resetCodexQuotaCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps transport failures to unavailable reasons instead of rejecting", async () => {
    runSession.mockRejectedValueOnce(new CodexAppServerError("cli-missing", "no codex"));
    await expect(readCodexQuota()).resolves.toMatchObject({ reason: "cli-missing" });

    resetCodexQuotaCacheForTests();
    runSession.mockRejectedValueOnce(new CodexAppServerError("timeout", "slow"));
    await expect(readCodexQuota()).resolves.toMatchObject({ reason: "timeout" });

    resetCodexQuotaCacheForTests();
    // What a signed-out or API-key session gets back.
    runSession.mockRejectedValueOnce(
      new CodexAppServerError("protocol-error", "Codex app-server: not logged in")
    );
    await expect(readCodexQuota()).resolves.toMatchObject({
      status: "unavailable",
      reason: "read-failed",
    });
  });

  it("shares one session between concurrent callers", async () => {
    respondWith(() => ({ rateLimits: { primary: FIVE_HOURS } }));
    const [a, b] = await Promise.all([readCodexQuota(), readCodexQuota()]);
    expect(a).toBe(b);
    expect(runSession).toHaveBeenCalledTimes(1);
  });

  it("re-reads an unavailable answer after 5s, so Retry isn't a no-op", async () => {
    runSession.mockRejectedValue(new CodexAppServerError("protocol-error", "signed out"));
    await readCodexQuota();
    vi.advanceTimersByTime(4_000);
    await readCodexQuota();
    expect(runSession).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_500);
    await readCodexQuota();
    expect(runSession).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache on an explicit refresh", async () => {
    respondWith(() => ({ rateLimits: { primary: FIVE_HOURS } }));
    await readCodexQuota();
    await refreshCodexQuota();
    expect(runSession).toHaveBeenCalledTimes(2);
  });

  it("serves the cache for 30s, then reads again", async () => {
    respondWith(() => ({ rateLimits: { primary: FIVE_HOURS } }));
    const first = await readCodexQuota();
    vi.advanceTimersByTime(29_000);
    expect(await readCodexQuota()).toBe(first);
    expect(runSession).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    const second = await readCodexQuota();
    expect(runSession).toHaveBeenCalledTimes(2);
    expect(second.fetchedAt).toBeGreaterThan(first.fetchedAt);
  });
});

describe("readCodexQuotaProfiles (#13686)", () => {
  let root: string;
  let originalHome: string | undefined;
  let defaultHome: string;
  let second: string;

  function presets(...entries: Array<{ id: string; name: string; env?: Record<string, string> }>) {
    agentSettings.value = { agents: { codex: { customPresets: entries } } };
  }

  /** Answers with a percentage that says which home was asked. */
  function respondPerHome(percentFor: (codexHome: string | undefined) => number) {
    runSession.mockImplementation(
      async (run: (call: Call) => Promise<unknown>, options: { codexHome?: string } = {}) =>
        run(async () => ({
          rateLimits: {
            primary: { usedPercent: percentFor(options.codexHome), windowDurationMins: 300 },
          },
        }))
    );
  }

  function used(result: { status: string; windows?: Array<{ usedPercent: number }> }) {
    return result.status === "ok" ? result.windows?.[0]?.usedPercent : result.status;
  }

  beforeEach(() => {
    runSession.mockReset();
    resetCodexQuotaCacheForTests();
    root = mkdtempSync(path.join(os.tmpdir(), "codex-quota-"));
    defaultHome = path.join(root, "default");
    second = path.join(root, "second");
    mkdirSync(defaultHome);
    mkdirSync(second);
    originalHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = defaultHome;
    agentSettings.value = undefined;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  describe("readCodexQuotaForHomes (#17318)", () => {
    async function homes(...dirs: string[]): Promise<Map<string, string>> {
      return new Map(
        await Promise.all(dirs.map(async (dir) => [await canonicalCodexHomeKey(dir), dir] as const))
      );
    }

    it("asks only about the homes an agent runs in, labelled as Settings labels them", async () => {
      const idle = path.join(root, "idle");
      mkdirSync(idle);
      presets(
        { id: "second", name: "Second account", env: { CODEX_HOME: second } },
        { id: "idle", name: "Idle", env: { CODEX_HOME: idle } }
      );
      respondPerHome((home) => (home === second ? 80 : 10));
      const readings = await readCodexQuotaForHomes(await homes(second));
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({
        homeKey: await canonicalCodexHomeKey(second),
        isDefault: false,
        presetNames: ["Second account"],
      });
      expect(used(readings[0]!.result)).toBe(80);
      expect(runSession.mock.calls.map((call) => call[1])).toEqual([{ codexHome: second }]);
    });

    it("names a saved account's home by the account", async () => {
      agentSettings.value = {
        agents: { codex: { accounts: [{ id: "company", name: "Company", configDir: second }] } },
      };
      respondPerHome(() => 55);
      const readings = await readCodexQuotaForHomes(await homes(second));
      expect(readings).toMatchObject([{ accountNames: ["Company"], presetNames: [] }]);
    });

    it("reads a home no profile names the way the pane runs it, unlabelled", async () => {
      const projectHome = path.join(root, "project-home");
      mkdirSync(projectHome);
      respondPerHome((home) => (home === projectHome ? 64 : 10));
      const readings = await readCodexQuotaForHomes(await homes(projectHome));
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({ isDefault: false, accountNames: [], presetNames: [] });
      expect(used(readings[0]!.result)).toBe(64);
      expect(runSession.mock.calls.map((call) => call[1])).toEqual([{ codexHome: projectHome }]);
    });

    it("never starts Codex for a home that isn't there, or for no home at all", async () => {
      respondPerHome(() => 10);
      expect(await readCodexQuotaForHomes(new Map())).toEqual([]);
      expect(await readCodexQuotaForHomes(await homes(path.join(root, "gone")))).toEqual([]);
      expect(runSession).not.toHaveBeenCalled();
    });

    describe("a background read nobody wants by its turn (#17981)", () => {
      /** Holds the queue on a read of the default home until `open` is called. */
      function holdQueue() {
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        const asked: Array<string | undefined> = [];
        runSession.mockImplementation(
          async (
            run: (call: Call) => Promise<unknown>,
            options: { codexHome?: string; beforeSpawn?: () => void } = {}
          ) => {
            if (options.codexHome === realpathSync.native(defaultHome)) await gate;
            // As the transport does once a slot is held: a throw here spawns nothing.
            options.beforeSpawn?.();
            asked.push(options.codexHome);
            return run(async () => ({
              rateLimits: { primary: { usedPercent: 33, windowDurationMins: 300 } },
            }));
          }
        );
        const held = readCodexHomeLimitEvidence(defaultHome);
        return { open, held, asked };
      }

      const turn = () => new Promise((resolve) => setTimeout(resolve, 100));

      it("is dropped without starting Codex, and a later read of the home still asks", async () => {
        const queue = holdQueue();
        let wanted = true;
        const background = readCodexQuotaForHomes(await homes(second), () => wanted);
        await turn();
        wanted = false;
        queue.open();
        await queue.held;
        await expect(background).resolves.toEqual([]);
        expect(queue.asked).toEqual([realpathSync.native(defaultHome)]);

        // Nothing was cached for it, so the next caller asks rather than reading a drop.
        const readings = await readCodexQuotaForHomes(await homes(second));
        expect(readings).toHaveLength(1);
        expect(queue.asked).toEqual([realpathSync.native(defaultHome), second]);
      });

      it("runs a queued background read that's still wanted by its turn", async () => {
        const queue = holdQueue();
        const background = readCodexQuotaForHomes(await homes(second), () => true);
        await turn();
        queue.open();
        await queue.held;
        const readings = await background;
        expect(readings).toHaveLength(1);
        expect(used(readings[0]!.result)).toBe(33);
        expect(queue.asked).toEqual([realpathSync.native(defaultHome), second]);
      });

      it("still runs once a caller that needs the answer has joined it", async () => {
        const queue = holdQueue();
        let wanted = true;
        const background = readCodexQuotaForHomes(await homes(second), () => wanted);
        await turn();
        // Asked with no way to be dropped: it joins the queued read rather than queueing a second.
        const explicit = readCodexQuotaForHomes(await homes(second));
        await turn();
        wanted = false;
        queue.open();
        await queue.held;
        const [readings, needed] = await Promise.all([background, explicit]);
        expect(readings).toHaveLength(1);
        expect(used(readings[0]!.result)).toBe(33);
        expect(needed).toEqual(readings);
        expect(queue.asked.filter((home) => home === second)).toHaveLength(1);
      });
    });
  });

  it("reads only the default profile when no preset sets a home", async () => {
    presets({ id: "fast", name: "Fast", env: { OTHER: "1" } });
    respondPerHome(() => 10);
    const profiles = await readCodexQuotaProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ isDefault: true, presetNames: [] });
    // The default still inherits main's env rather than being pinned to a path.
    expect(runSession.mock.calls[0]?.[1]).toEqual({});
  });

  it("reads each preset home with its own CODEX_HOME and labels it", async () => {
    presets({ id: "second", name: "Second account", env: { CODEX_HOME: second } });
    respondPerHome((home) => (home === second ? 80 : 10));
    const profiles = await readCodexQuotaProfiles();
    expect(profiles.map((p) => [p.isDefault, p.presetNames, used(p.result)])).toEqual([
      [true, [], 10],
      [false, ["Second account"], 80],
    ]);
    expect(profiles[0]?.key).not.toBe(profiles[1]?.key);
  });

  it("reads each account's folder and labels it with the account, beside a preset on the same home (#16040)", async () => {
    const third = path.join(root, "third");
    mkdirSync(third);
    agentSettings.value = {
      agents: {
        codex: {
          accounts: [
            { id: "company", name: "Company", configDir: second },
            { id: "lab", name: "Lab", configDir: third },
          ],
          customPresets: [{ id: "legacy", name: "Legacy", env: { CODEX_HOME: second } }],
        },
      },
    };
    respondPerHome((home) => (home === second ? 80 : home === third ? 30 : 10));
    const profiles = await readCodexQuotaProfiles();
    expect(
      profiles.map((p) => [p.isDefault, p.accountNames ?? [], p.presetNames, used(p.result)])
    ).toEqual([
      [true, [], [], 10],
      [false, ["Company"], ["Legacy"], 80],
      [false, ["Lab"], [], 30],
    ]);
  });

  it("names each account's id beside its name, so accounts sharing a name stay apart (#16407)", async () => {
    const third = path.join(root, "third");
    mkdirSync(third);
    agentSettings.value = {
      agents: {
        codex: {
          accounts: [
            { id: "company", name: "Work", configDir: second },
            { id: "lab", name: "Work", configDir: third },
            { id: "alias", name: "Alias", configDir: defaultHome },
          ],
        },
      },
    };
    respondPerHome((home) => (home === second ? 80 : home === third ? 30 : 10));
    const profiles = await readCodexQuotaProfiles();
    expect(profiles.map((p) => [p.isDefault, p.accountIds ?? [], used(p.result)])).toEqual([
      [true, ["alias"], 10],
      [false, ["company"], 80],
      [false, ["lab"], 30],
    ]);
  });

  it("keeps the ids of every account whose home folds into one row (#16407)", async () => {
    const link = path.join(root, "link");
    symlinkSync(second, link, "junction");
    agentSettings.value = {
      agents: {
        codex: {
          accounts: [
            { id: "company", name: "Company", configDir: second },
            { id: "alias", name: "Alias", configDir: link },
          ],
        },
      },
    };
    respondPerHome(() => 5);
    const profiles = await readCodexQuotaProfiles();
    expect(profiles.map((p) => p.accountIds ?? [])).toEqual([[], ["company", "alias"]]);
  });

  it("files a preset under the account it pins, over its own CODEX_HOME (#16133)", async () => {
    const third = path.join(root, "third");
    mkdirSync(third);
    agentSettings.value = {
      agents: {
        codex: {
          accounts: [{ id: "lab", name: "Lab", configDir: third }],
          customPresets: [
            { id: "pinned", name: "Pinned", accountId: "lab", env: { CODEX_HOME: second } },
            { id: "bare-pin", name: "Bare pin", accountId: "lab" },
            // Its launches are refused, so no reading speaks for it.
            { id: "gone", name: "Gone", accountId: "removed", env: { CODEX_HOME: second } },
          ],
        },
      },
    };
    respondPerHome((home) => (home === third ? 30 : 10));
    const profiles = await readCodexQuotaProfiles();
    expect(
      profiles.map((p) => [p.isDefault, p.accountNames ?? [], p.presetNames, used(p.result)])
    ).toEqual([
      [true, [], [], 10],
      [false, ["Lab"], ["Pinned", "Bare pin"], 30],
    ]);
  });

  it("folds presets that share a home, including one pointing at the default", async () => {
    presets(
      { id: "a", name: "Work", env: { CODEX_HOME: second } },
      { id: "b", name: "Work review", env: { codex_home: `${second}/` } },
      { id: "c", name: "Personal", env: { CODEX_HOME: defaultHome } }
    );
    respondPerHome(() => 5);
    const profiles = await readCodexQuotaProfiles();
    expect(profiles.map((p) => p.presetNames)).toEqual([["Personal"], ["Work", "Work review"]]);
    expect(runSession).toHaveBeenCalledTimes(2);
  });

  it("never spawns for a missing or relative home, and never falls back to the default", async () => {
    presets(
      { id: "gone", name: "Gone", env: { CODEX_HOME: path.join(root, "nope") } },
      { id: "tilde", name: "Tilde", env: { CODEX_HOME: "~/.codex-2" } }
    );
    respondPerHome(() => 10);
    const profiles = await readCodexQuotaProfiles();
    expect(profiles.map((p) => used(p.result))).toEqual([10, "unavailable", "unavailable"]);
    expect(
      profiles.slice(1).map((p) => p.result.status === "unavailable" && p.result.reason)
    ).toEqual(["home-missing", "home-not-absolute"]);
    expect(runSession).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(root, "nope"))).toBe(false);
  });

  it("runs one read at a time across homes and callers", async () => {
    presets({ id: "second", name: "Second", env: { CODEX_HOME: second } });
    respondPerHome(() => 10);
    await readCodexQuotaProfiles();

    // Hold the second home's session open, then ask for the default past its
    // cache: the queue, not the per-home join, is what must keep it waiting.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started: Array<string | undefined> = [];
    runSession.mockImplementation(
      async (run: (call: Call) => Promise<unknown>, options: { codexHome?: string } = {}) => {
        started.push(options.codexHome);
        if (options.codexHome === second) await gate;
        return run(async () => ({ rateLimits: { primary: FIVE_HOURS } }));
      }
    );
    const batch = refreshCodexQuotaProfiles();
    await vi.waitFor(() => expect(started).toEqual([undefined, second]));
    const lone = refreshCodexQuota();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual([undefined, second]);

    release();
    await Promise.all([batch, lone]);
    expect(started).toEqual([undefined, second, undefined]);
  });

  it("treats a trailing space or a file as a different, unreadable home", async () => {
    writeFileSync(path.join(root, "file"), "");
    presets(
      { id: "space", name: "Space", env: { CODEX_HOME: `${defaultHome} ` } },
      { id: "file", name: "File", env: { CODEX_HOME: path.join(root, "file") } }
    );
    respondPerHome(() => 10);
    const profiles = await readCodexQuotaProfiles();
    expect(profiles.map((p) => [p.presetNames, used(p.result)])).toEqual([
      [[], 10],
      [["Space"], "unavailable"],
      [["File"], "unavailable"],
    ]);
    expect(runSession).toHaveBeenCalledTimes(1);
  });

  it("caches per home, and a refresh re-reads every profile", async () => {
    presets({ id: "second", name: "Second", env: { CODEX_HOME: second } });
    respondPerHome(() => 10);
    await readCodexQuotaProfiles();
    await readCodexQuotaProfiles();
    expect(runSession).toHaveBeenCalledTimes(2);
    // The MCP path reads main's default and shares its cache entry.
    await readCodexQuota();
    expect(runSession).toHaveBeenCalledTimes(2);
    await refreshCodexQuotaProfiles();
    expect(runSession).toHaveBeenCalledTimes(4);
  });

  describe("one login, one row (#13702)", () => {
    /** Each home answers with the workspace id and email given for it. */
    function respondAs(
      identityFor: (codexHome: string | undefined) => {
        accountId?: string | null;
        email?: string | null;
        accountRead?: "throws";
      }
    ) {
      const methods: string[] = [];
      runSession.mockImplementation(
        async (run: (call: Call) => Promise<unknown>, options: { codexHome?: string } = {}) =>
          run(async (method) => {
            methods.push(method);
            const identity = identityFor(options.codexHome);
            if (method === "account/rateLimits/read") {
              return { rateLimits: { primary: FIVE_HOURS }, accountId: identity.accountId ?? null };
            }
            if (method === "account/read") {
              if (identity.accountRead === "throws") throw new Error("method not found");
              return {
                account: { type: "chatgpt", email: identity.email ?? null, planType: "plus" },
                requiresOpenaiAuth: true,
              };
            }
            throw new Error(`unexpected ${method}`);
          })
      );
      return methods;
    }

    it("folds a symlink to a preset home into that home's row", async () => {
      const link = path.join(root, "link");
      symlinkSync(second, link, "junction");
      presets(
        { id: "a", name: "Work", env: { CODEX_HOME: second } },
        { id: "b", name: "Work alias", env: { CODEX_HOME: link } }
      );
      respondPerHome(() => 5);
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => p.presetNames)).toEqual([[], ["Work", "Work alias"]]);
      expect(runSession).toHaveBeenCalledTimes(2);
      // The first spelling is the one Codex is launched with, as a pane would.
      expect(runSession.mock.calls[1]?.[1]).toEqual({ codexHome: second });
    });

    it("folds a symlink to the default home into the default row", async () => {
      const link = path.join(root, "default-link");
      symlinkSync(defaultHome, link, "junction");
      presets({ id: "a", name: "Personal", env: { CODEX_HOME: link } });
      respondPerHome(() => 5);
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => [p.isDefault, p.presetNames])).toEqual([[true, ["Personal"]]]);
      expect(runSession).toHaveBeenCalledTimes(1);
    });

    it("folds a different-case spelling on a case-insensitive volume", async () => {
      const upper = path.join(root, "SECOND");
      const caseInsensitive = existsSync(upper);
      presets(
        { id: "a", name: "Work", env: { CODEX_HOME: second } },
        { id: "b", name: "Work upper", env: { CODEX_HOME: upper } }
      );
      respondPerHome(() => 5);
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => p.presetNames)).toEqual(
        caseInsensitive ? [[], ["Work", "Work upper"]] : [[], ["Work"], ["Work upper"]]
      );
    });

    it("folds two homes signed into the same login, but still reads both", async () => {
      presets({ id: "a", name: "Work", env: { CODEX_HOME: second } });
      respondAs(() => ({ accountId: "ws-1", email: "me@example.com" }));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => [p.isDefault, p.presetNames, p.result.status])).toEqual([
        [true, ["Work"], "ok"],
      ]);
      expect(runSession).toHaveBeenCalledTimes(2);
      // The identity stays in main.
      expect(JSON.stringify(profiles)).not.toMatch(/ws-1|example\.com/);
    });

    it("keeps the ids of the accounts in every home that folds into one login (#16407)", async () => {
      const third = path.join(root, "third");
      mkdirSync(third);
      agentSettings.value = {
        agents: {
          codex: {
            accounts: [
              { id: "company", name: "Company", configDir: second },
              { id: "lab", name: "Lab", configDir: third },
            ],
          },
        },
      };
      respondAs(() => ({ accountId: "ws-1", email: "me@example.com" }));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        isDefault: true,
        accountIds: ["company", "lab"],
        accountNames: ["Company", "Lab"],
      });
    });

    it("keeps two users of one Team workspace apart", async () => {
      presets({ id: "a", name: "Colleague", env: { CODEX_HOME: second } });
      respondAs((home) => ({
        accountId: "ws-team",
        email: home === second ? "them@example.com" : "me@example.com",
      }));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => p.presetNames)).toEqual([[], ["Colleague"]]);
    });

    it("never folds on the workspace id alone", async () => {
      presets({ id: "a", name: "Work", env: { CODEX_HOME: second } });
      respondAs(() => ({ accountId: "ws-1", accountRead: "throws" }));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => [p.presetNames, p.result.status])).toEqual([
        [[], "ok"],
        [["Work"], "ok"],
      ]);
    });

    it("doesn't ask for the account when the reading names no workspace", async () => {
      presets({ id: "a", name: "Work", env: { CODEX_HOME: second } });
      const methods = respondAs(() => ({ accountId: null, email: "me@example.com" }));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles).toHaveLength(2);
      expect(methods).toEqual(["account/rateLimits/read", "account/rateLimits/read"]);
    });

    it("keeps a quota that arrived when the session dies during the account read", async () => {
      // The account read never answers; the transport's deadline is what ends it.
      runSession.mockImplementation(async (run: (call: Call) => Promise<unknown>) => {
        void run(async (method) => {
          if (method === "account/rateLimits/read") {
            return { rateLimits: { primary: FIVE_HOURS }, accountId: "ws-1" };
          }
          return new Promise(() => {});
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new CodexAppServerError("timeout", "session deadline");
      });
      const result = await refreshCodexQuota();
      expect(used(result)).toBe(42.4);
    });

    it("shows the freshest reading when two homes fold into one login", async () => {
      presets({ id: "a", name: "Work", env: { CODEX_HOME: second } });
      respondAs(() => ({ accountId: "ws-1", email: "me@example.com" }));
      await readCodexQuota();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 10_000);
        runSession.mockImplementation(
          async (run: (call: Call) => Promise<unknown>, options: { codexHome?: string } = {}) =>
            run(async (method) => {
              if (method === "account/read") {
                return { account: { type: "chatgpt", email: "me@example.com" } };
              }
              const usedPercent = options.codexHome === second ? 99 : 1;
              return {
                rateLimits: { primary: { usedPercent, windowDurationMins: 300 } },
                accountId: "ws-1",
              };
            })
        );
        const profiles = await readCodexQuotaProfiles();
        expect(profiles.map((p) => [p.isDefault, p.presetNames, used(p.result)])).toEqual([
          [true, ["Work"], 99],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lists folded presets in preset order, not home order", async () => {
      const link = path.join(root, "second-link");
      symlinkSync(second, link, "junction");
      presets(
        { id: "a", name: "First", env: { CODEX_HOME: second } },
        { id: "b", name: "Second", env: { CODEX_HOME: defaultHome } },
        { id: "c", name: "Third", env: { CODEX_HOME: link } }
      );
      respondAs(() => ({ accountId: "ws-1", email: "me@example.com" }));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => p.presetNames)).toEqual([["First", "Second", "Third"]]);
    });

    it("folds a cached reading too", async () => {
      presets({ id: "a", name: "Work", env: { CODEX_HOME: second } });
      respondAs(() => ({ accountId: "ws-1", email: "me@example.com" }));
      await readCodexQuotaProfiles();
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => p.presetNames)).toEqual([["Work"]]);
      expect(runSession).toHaveBeenCalledTimes(2);
    });
  });

  describe("the agent-wide CODEX_HOME (#15047)", () => {
    function codexEntry(entry: Record<string, unknown>) {
      agentSettings.value = { agents: { codex: entry } };
    }

    it("reads the default row from the agent-wide home, not main's", async () => {
      codexEntry({ globalEnv: { CODEX_HOME: second } });
      respondPerHome((home) => (home === second ? 80 : 10));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => [p.isDefault, p.presetNames, used(p.result)])).toEqual([
        [true, [], 80],
      ]);
      expect(runSession.mock.calls.map((call) => call[1])).toEqual([{ codexHome: second }]);
    });

    it("points the MCP default reading at the agent-wide home too", async () => {
      codexEntry({ globalEnv: { codex_home: second } });
      respondPerHome((home) => (home === second ? 80 : 10));
      expect(used(await readCodexQuota())).toBe(80);
    });

    it("gives a preset on main's home its own row once the default has moved", async () => {
      codexEntry({
        globalEnv: { CODEX_HOME: second },
        customPresets: [{ id: "p", name: "Personal", env: { CODEX_HOME: defaultHome } }],
      });
      respondPerHome((home) => (home === second ? 80 : 10));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => [p.isDefault, p.presetNames, used(p.result)])).toEqual([
        [true, [], 80],
        [false, ["Personal"], 10],
      ]);
      // Named outright: the preset's home must not depend on main's env.
      expect(runSession.mock.calls.map((call) => call[1])).toEqual([
        { codexHome: second },
        { codexHome: defaultHome },
      ]);
    });

    it("folds a preset naming the agent-wide home into the default row", async () => {
      codexEntry({
        globalEnv: { CODEX_HOME: second },
        customPresets: [{ id: "w", name: "Work", env: { CODEX_HOME: `${second}/` } }],
      });
      respondPerHome(() => 5);
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => [p.isDefault, p.presetNames])).toEqual([[true, ["Work"]]]);
      expect(runSession).toHaveBeenCalledTimes(1);
    });

    it("never falls back to main's account for a missing or relative agent-wide home", async () => {
      const missing = path.join(root, "nope");
      for (const home of [missing, "~/.codex-2"]) {
        codexEntry({ globalEnv: { CODEX_HOME: home } });
        respondPerHome(() => 10);
        const profiles = await readCodexQuotaProfiles();
        expect(profiles.map((p) => [p.isDefault, p.result])).toEqual([
          [
            true,
            {
              status: "unavailable",
              reason: home === missing ? "home-missing" : "home-not-absolute",
              fetchedAt: expect.any(Number),
            },
          ],
        ]);
        // The MCP schema has no home reasons; it still never reads main's home.
        await expect(refreshCodexQuota()).resolves.toMatchObject({ reason: "read-failed" });
      }
      expect(runSession).not.toHaveBeenCalled();
      expect(existsSync(missing)).toBe(false);
    });

    it("falls through to main's home when the launch would drop the value", async () => {
      codexEntry({ globalEnv: { CODEX_HOME: `${second};x` } });
      respondPerHome((home) => (home === undefined ? 10 : 80));
      const profiles = await readCodexQuotaProfiles();
      expect(profiles.map((p) => used(p.result))).toEqual([10]);
      expect(runSession.mock.calls.map((call) => call[1])).toEqual([{}]);
    });

    it("shares the agent-wide home's reading between Settings and MCP", async () => {
      codexEntry({ globalEnv: { CODEX_HOME: second } });
      respondPerHome((home) => (home === second ? 80 : 10));
      const profiles = await readCodexQuotaProfiles();
      const mcp = await readCodexQuota();
      expect([used(profiles[0]!.result), used(mcp)]).toEqual([80, 80]);
      expect(runSession.mock.calls.map((call) => call[1])).toEqual([{ codexHome: second }]);
    });

    describe("an empty value", () => {
      let fallback: string;

      beforeEach(() => {
        // Main's own home is elsewhere, so landing on it would be the wrong account.
        vi.spyOn(os, "homedir").mockReturnValue(root);
        fallback = path.join(root, ".codex");
        mkdirSync(fallback);
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("reads Codex's own fallback home, as the cleared launch env does", async () => {
        codexEntry({ globalEnv: { CODEX_HOME: "" } });
        respondPerHome((home) => (home === fallback ? 80 : 10));
        const profiles = await readCodexQuotaProfiles();
        expect(profiles.map((p) => [p.isDefault, used(p.result)])).toEqual([[true, 80]]);
        expect(used(await readCodexQuota())).toBe(80);
        expect(runSession.mock.calls.map((call) => call[1])).toEqual([{ codexHome: fallback }]);
      });

      it("gives a preset that clears the agent-wide home a row of its own", async () => {
        codexEntry({
          globalEnv: { CODEX_HOME: second },
          customPresets: [{ id: "c", name: "Cleared", env: { CODEX_HOME: "" } }],
        });
        respondPerHome((home) => (home === fallback ? 10 : 80));
        const profiles = await readCodexQuotaProfiles();
        expect(profiles.map((p) => [p.isDefault, p.presetNames, used(p.result)])).toEqual([
          [true, [], 80],
          [false, ["Cleared"], 10],
        ]);
      });
    });
  });

  it("keeps going after one home's read fails", async () => {
    presets({ id: "second", name: "Second", env: { CODEX_HOME: second } });
    runSession.mockImplementation(
      async (run: (call: Call) => Promise<unknown>, options: { codexHome?: string } = {}) => {
        if (options.codexHome === undefined) throw new CodexAppServerError("timeout", "slow");
        return run(async () => ({ rateLimits: { primary: FIVE_HOURS } }));
      }
    );
    const profiles = await readCodexQuotaProfiles();
    expect(profiles.map((p) => p.result.status)).toEqual(["unavailable", "ok"]);
  });
});

describe("toCodexLimitEvidence (#17906)", () => {
  it("keeps every bucket of the per-limit map, a window with no duration included", () => {
    const evidence = toCodexLimitEvidence(
      {
        rateLimits: { limitId: "codex", primary: FIVE_HOURS },
        rateLimitsByLimitId: {
          codex: { limitId: "codex", limitName: null, primary: FIVE_HOURS, secondary: WEEK },
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            limitName: "GPT-5.5-Codex",
            primary: { usedPercent: 100, windowDurationMins: null, resetsAt: 1_700_000_100 },
            secondary: null,
          },
          // No id inside the snapshot, and a spent window with no reset.
          "gpt-reserve": {
            limitName: "gpt-reserve",
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
          },
        },
      },
      7,
      9
    );
    expect(evidence).toEqual({
      requestedAt: 7,
      receivedAt: 9,
      buckets: [
        {
          limitId: "codex",
          limitName: null,
          windows: [
            { usedPercent: 42.4, resetsAt: 1_700_000_000_000 },
            { usedPercent: 12, resetsAt: 1_700_500_000_000 },
          ],
          unreadable: false,
        },
        {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.5-Codex",
          windows: [{ usedPercent: 100, resetsAt: 1_700_000_100_000 }],
          unreadable: false,
        },
        {
          limitId: "gpt-reserve",
          limitName: "gpt-reserve",
          windows: [{ usedPercent: 100, resetsAt: null }],
          unreadable: false,
        },
      ],
    });
  });

  it("reads an older CLI's single snapshot, and marks a window it can't read", () => {
    expect(
      toCodexLimitEvidence(
        { rateLimits: { primary: { usedPercent: "full" }, secondary: WEEK } },
        1,
        2
      )
    ).toEqual({
      requestedAt: 1,
      receivedAt: 2,
      buckets: [
        {
          limitId: null,
          limitName: null,
          windows: [{ usedPercent: 12, resetsAt: 1_700_500_000_000 }],
          unreadable: true,
        },
      ],
    });
    expect(toCodexLimitEvidence(null, 1, 2)).toBeNull();
  });
});

describe("readCodexHomeLimitEvidence (#17906)", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    runSession.mockReset();
    resetCodexQuotaCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    root = mkdtempSync(path.join(os.tmpdir(), "codex-limit-"));
    home = path.join(root, "work");
    mkdirSync(home);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it("asks the pane's own home, stamped with when the request went out and came back", async () => {
    runSession.mockImplementation(async (run: (call: Call) => Promise<unknown>) => {
      // Queued behind other work: the request leaves later than the caller asked.
      vi.setSystemTime(1_000_500);
      return run(async () => {
        vi.setSystemTime(1_002_000);
        return { rateLimits: { primary: FIVE_HOURS } };
      });
    });
    const evidence = await readCodexHomeLimitEvidence(home);
    expect(runSession).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ codexHome: realpathSync.native(home) })
    );
    expect(evidence).toMatchObject({ requestedAt: 1_000_500, receivedAt: 1_002_000 });
    expect(evidence?.buckets[0]?.windows).toEqual([
      { usedPercent: 42.4, resetsAt: 1_700_000_000_000 },
    ]);
  });

  it("asks anew every time, never taking or leaving a cached reading", async () => {
    respondWith(() => ({ rateLimits: { primary: FIVE_HOURS } }));
    const physicalHome = realpathSync.native(home);
    const homes = new Map([[await canonicalCodexHomeKey(physicalHome), physicalHome]]);
    await readCodexQuotaForHomes(homes);
    await readCodexHomeLimitEvidence(home);
    await readCodexHomeLimitEvidence(home);
    expect(runSession).toHaveBeenCalledTimes(3);
    // The usage read still serves its own cache, untouched by the two above.
    await readCodexQuotaForHomes(homes);
    expect(runSession).toHaveBeenCalledTimes(3);
  });

  it("asks the folder a link names, as it names it when asked", async () => {
    const link = path.join(root, "current");
    symlinkSync(home, link, "junction");
    const asked: Array<string | undefined> = [];
    runSession.mockImplementation(
      async (run: (call: Call) => Promise<unknown>, options: { codexHome?: string } = {}) => {
        asked.push(options.codexHome);
        return run(async () => ({ rateLimits: { primary: FIVE_HOURS } }));
      }
    );
    await readCodexHomeLimitEvidence(link);
    expect(asked).toEqual([realpathSync.native(home)]);
  });

  it("keeps the evidence when the session dies during the account read", async () => {
    runSession.mockImplementation(async (run: (call: Call) => Promise<unknown>) => {
      void run(async (method) => {
        if (method === "account/rateLimits/read") {
          return { rateLimits: { primary: FIVE_HOURS }, accountId: "ws-1" };
        }
        return new Promise(() => {});
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      vi.setSystemTime(1_009_000);
      throw new CodexAppServerError("timeout", "session deadline");
    });
    const evidence = await readCodexHomeLimitEvidence(home);
    expect(evidence).toMatchObject({
      requestedAt: 1_000_000,
      receivedAt: 1_000_000,
      buckets: [{ limitId: null, windows: [{ usedPercent: 42.4 }] }],
    });
  });

  it("never asks about a home Codex hasn't made", async () => {
    expect(await readCodexHomeLimitEvidence(path.join(root, "missing"))).toBeNull();
    expect(runSession).not.toHaveBeenCalled();
  });
});
