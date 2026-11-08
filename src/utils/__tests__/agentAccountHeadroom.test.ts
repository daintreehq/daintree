import { describe, expect, it } from "vitest";
import {
  accountHeadroom,
  presetNamesAccountFolder,
  type AccountHeadroomSources,
} from "../agentAccountHeadroom";
import {
  CODEX_QUOTA_STALE_AFTER_MS,
  type ClaudeUsageAccount,
  type ClaudeUsageReading,
  type CodexQuotaProfile,
  type CodexQuotaWindow,
} from "@shared/types/ipc/agentQuota";

const HOUR = 60 * 60_000;
// Noon local time, so same-day resets read as a bare clock time.
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const AT = (hours: number) => NOW + hours * HOUR;

function codexProfile(
  patch: Partial<CodexQuotaProfile> & { windows?: CodexQuotaWindow[]; fetchedAt?: number }
): CodexQuotaProfile {
  const { windows, fetchedAt, ...rest } = patch;
  return {
    key: "k",
    isDefault: false,
    presetNames: [],
    result: {
      status: "ok",
      planType: "plus",
      windows: windows ?? [{ usedPercent: 40, windowDurationMins: 300, resetsAt: AT(2) }],
      fetchedAt: fetchedAt ?? NOW,
    },
    ...rest,
  };
}

function reading(patch: Partial<ClaudeUsageReading>): ClaudeUsageReading {
  return {
    window: "weekly limit",
    statement: "used",
    usedPercent: 87,
    resetsAt: AT(30),
    observedAt: NOW - 3 * HOUR,
    terminalId: "t1",
    paneTitle: null,
    projectName: null,
    ...patch,
  };
}

function claudeAccount(
  patch: Partial<ClaudeUsageAccount> & { readings: ClaudeUsageReading[] }
): ClaudeUsageAccount {
  return { key: "c", kind: "account", accountNames: [], accountIds: [], ...patch };
}

const codexOnly = (...profiles: CodexQuotaProfile[]): AccountHeadroomSources => ({
  codex: profiles,
  claude: null,
});
const claudeOnly = (...accounts: ClaudeUsageAccount[]): AccountHeadroomSources => ({
  codex: null,
  claude: accounts,
});

describe("accountHeadroom for Codex (#16407)", () => {
  it("shows the tightest window and its reset for the account's profile", () => {
    const profile = codexProfile({
      accountIds: ["work"],
      windows: [
        { usedPercent: 30, windowDurationMins: 300, resetsAt: AT(2) },
        { usedPercent: 82, windowDurationMins: 10080, resetsAt: AT(2) },
      ],
    });
    const headroom = accountHeadroom(
      "codex",
      { kind: "account", accountId: "work" },
      codexOnly(profile),
      NOW
    );
    expect(headroom?.stale).toBe(false);
    expect(headroom?.text).toMatch(/^Weekly limit 82% used · resets \d/);
  });

  it("matches by id, so two accounts with one name stay apart", () => {
    const first = codexProfile({
      key: "a",
      accountIds: ["one"],
      accountNames: ["Work"],
      windows: [{ usedPercent: 10, windowDurationMins: 300, resetsAt: null }],
    });
    const second = codexProfile({
      key: "b",
      accountIds: ["two"],
      accountNames: ["Work"],
      windows: [{ usedPercent: 90, windowDurationMins: 300, resetsAt: null }],
    });
    const sources = codexOnly(first, second);
    expect(
      accountHeadroom("codex", { kind: "account", accountId: "one" }, sources, NOW)?.text
    ).toBe("5-hour limit 10% used");
    expect(
      accountHeadroom("codex", { kind: "account", accountId: "two" }, sources, NOW)?.text
    ).toBe("5-hour limit 90% used");
  });

  it("shows nothing for an account no profile claims, a host that sent no ids, or an unreadable home", () => {
    const withIds = codexProfile({ accountIds: ["work"] });
    expect(
      accountHeadroom("codex", { kind: "account", accountId: "lab" }, codexOnly(withIds), NOW)
    ).toBeUndefined();
    expect(
      accountHeadroom(
        "codex",
        { kind: "account", accountId: "work" },
        codexOnly(codexProfile({})),
        NOW
      )
    ).toBeUndefined();
    const unavailable = codexProfile({
      accountIds: ["work"],
      result: { status: "unavailable", reason: "read-failed", fetchedAt: NOW },
    });
    expect(
      accountHeadroom("codex", { kind: "account", accountId: "work" }, codexOnly(unavailable), NOW)
    ).toBeUndefined();
  });

  it("takes the default login from the default profile, unless its preset names a folder", () => {
    const sources = codexOnly(
      codexProfile({
        isDefault: true,
        key: "d",
        windows: [{ usedPercent: 15, windowDurationMins: 300, resetsAt: null }],
      }),
      codexProfile({ key: "other", accountIds: ["work"] })
    );
    expect(accountHeadroom("codex", { kind: "default" }, sources, NOW)?.text).toBe(
      "5-hour limit 15% used"
    );
    expect(
      accountHeadroom("codex", { kind: "default", presetNamesFolder: true }, sources, NOW)
    ).toBeUndefined();
  });

  it("marks a reading stale once its fetch is old", () => {
    const profile = codexProfile({
      accountIds: ["work"],
      fetchedAt: NOW - CODEX_QUOTA_STALE_AFTER_MS - 1,
    });
    const headroom = accountHeadroom(
      "codex",
      { kind: "account", accountId: "work" },
      codexOnly(profile),
      NOW
    );
    expect(headroom?.stale).toBe(true);
    expect(headroom?.text.startsWith("Stale · ")).toBe(true);
  });

  it("prefers a window that hasn't reset, and marks the figure stale once every window has", () => {
    const mixed = codexProfile({
      accountIds: ["work"],
      windows: [
        { usedPercent: 95, windowDurationMins: 300, resetsAt: NOW - HOUR },
        { usedPercent: 20, windowDurationMins: 10080, resetsAt: AT(40) },
      ],
    });
    const live = accountHeadroom(
      "codex",
      { kind: "account", accountId: "work" },
      codexOnly(mixed),
      NOW
    );
    expect(live?.text).toMatch(/^Weekly limit 20% used/);
    expect(live?.stale).toBe(false);

    const over = codexProfile({
      accountIds: ["work"],
      windows: [{ usedPercent: 95, windowDurationMins: 300, resetsAt: NOW - HOUR }],
    });
    const stale = accountHeadroom(
      "codex",
      { kind: "account", accountId: "work" },
      codexOnly(over),
      NOW
    );
    expect(stale?.stale).toBe(true);
    expect(stale?.text).toMatch(/^Stale · 5-hour limit 95% used · reset /);
  });

  it("picks the tightest window whichever order the windows arrive in", () => {
    const windows: CodexQuotaWindow[] = [
      { usedPercent: 82, windowDurationMins: 10080, resetsAt: null },
      { usedPercent: 30, windowDurationMins: 300, resetsAt: null },
    ];
    for (const ordered of [windows, [...windows].reverse()]) {
      const profile = codexProfile({ accountIds: ["work"], windows: ordered });
      expect(
        accountHeadroom("codex", { kind: "account", accountId: "work" }, codexOnly(profile), NOW)
          ?.text
      ).toBe("Weekly limit 82% used");
    }
  });

  it("breaks a tie on use by the shorter window, whichever order they arrive in", () => {
    const windows: CodexQuotaWindow[] = [
      { usedPercent: 50, windowDurationMins: 10080, resetsAt: null },
      { usedPercent: 50, windowDurationMins: 300, resetsAt: null },
    ];
    for (const ordered of [windows, [...windows].reverse()]) {
      const profile = codexProfile({ accountIds: ["work"], windows: ordered });
      expect(
        accountHeadroom("codex", { kind: "account", accountId: "work" }, codexOnly(profile), NOW)
          ?.text
      ).toBe("5-hour limit 50% used");
    }
  });

  it("treats a reset at exactly now as passed, and a fetch exactly at the threshold as current", () => {
    const profile = (patch: Parameters<typeof codexProfile>[0]) =>
      accountHeadroom(
        "codex",
        { kind: "account", accountId: "work" },
        codexOnly(codexProfile({ accountIds: ["work"], ...patch })),
        NOW
      );
    expect(
      profile({ windows: [{ usedPercent: 50, windowDurationMins: 300, resetsAt: NOW }] })?.stale
    ).toBe(true);
    expect(profile({ fetchedAt: NOW - CODEX_QUOTA_STALE_AFTER_MS })?.stale).toBe(false);
  });

  it("shows nothing for a profile without windows, or when two profiles claim one account", () => {
    expect(
      accountHeadroom(
        "codex",
        { kind: "account", accountId: "work" },
        codexOnly(codexProfile({ accountIds: ["work"], windows: [] })),
        NOW
      )
    ).toBeUndefined();
    expect(
      accountHeadroom(
        "codex",
        { kind: "account", accountId: "work" },
        codexOnly(
          codexProfile({ key: "a", accountIds: ["work"] }),
          codexProfile({ key: "b", accountIds: ["work"] })
        ),
        NOW
      )
    ).toBeUndefined();
  });

  it("names the reset in the viewer's clock, with the weekday beyond today and the date beyond a week", () => {
    const text = (resetsAt: number) =>
      accountHeadroom(
        "codex",
        { kind: "account", accountId: "work" },
        codexOnly(
          codexProfile({
            accountIds: ["work"],
            windows: [{ usedPercent: 50, windowDurationMins: 300, resetsAt }],
          })
        ),
        NOW
      )?.text;
    const clock = (at: number) =>
      new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const sameDay = NOW + 12 * 60_000;
    expect(text(sameDay)).toBe(`5-hour limit 50% used · resets ${clock(sameDay)}`);

    const tomorrow = AT(30);
    const weekday = new Date(tomorrow).toLocaleDateString(undefined, { weekday: "short" });
    expect(text(tomorrow)).toBe(`5-hour limit 50% used · resets ${weekday} ${clock(tomorrow)}`);

    const later = AT(24 * 10);
    const date = new Date(later).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(text(later)).toBe(`5-hour limit 50% used · resets ${date} ${clock(later)}`);
  });

  it("breaks a tie on use by the shorter window and leaves out a reset it wasn't told", () => {
    const profile = codexProfile({
      accountIds: ["work"],
      windows: [
        { usedPercent: 50, windowDurationMins: 10080, resetsAt: null },
        { usedPercent: 50, windowDurationMins: 300, resetsAt: null },
      ],
    });
    expect(
      accountHeadroom("codex", { kind: "account", accountId: "work" }, codexOnly(profile), NOW)
        ?.text
    ).toBe("5-hour limit 50% used");
  });
});

describe("accountHeadroom for Claude Code (#16407)", () => {
  const target = { kind: "account", accountId: "work" } as const;

  it("says the figure was observed in a pane, and how long ago", () => {
    const headroom = accountHeadroom(
      "claude",
      target,
      claudeOnly(claudeAccount({ accountIds: ["work"], readings: [reading({})] })),
      NOW
    );
    expect(headroom?.stale).toBe(false);
    expect(headroom?.text).toMatch(/^Weekly limit 87% used · resets .+ · observed 3h ago$/);
  });

  it("keeps a stated bound a bound, and says so when no figure was printed", () => {
    const over = claudeAccount({
      accountIds: ["work"],
      readings: [reading({ statement: "over", usedPercent: 90 })],
    });
    expect(accountHeadroom("claude", target, claudeOnly(over), NOW)?.text).toMatch(
      /^Weekly limit over 90% used/
    );
    const approaching = claudeAccount({
      accountIds: ["work"],
      readings: [reading({ window: "5-hour limit", statement: "approaching", usedPercent: null })],
    });
    expect(accountHeadroom("claude", target, claudeOnly(approaching), NOW)?.text).toMatch(
      /^Approaching 5-hour limit/
    );
    const reached = claudeAccount({
      accountIds: ["work"],
      readings: [
        reading({ window: "limit", statement: "reached", usedPercent: null, resetsAt: null }),
      ],
    });
    expect(accountHeadroom("claude", target, claudeOnly(reached), NOW)?.text).toBe(
      "Limit reached · observed 3h ago"
    );
  });

  it("breaks ties on a figure by a floor over an exact one, then the newer message, then the window order", () => {
    const pick = (readings: ClaudeUsageReading[]) =>
      accountHeadroom(
        "claude",
        target,
        claudeOnly(claudeAccount({ accountIds: ["work"], readings })),
        NOW
      )?.text;
    // A higher exact figure beats a lower floor.
    expect(
      pick([
        reading({ window: "Opus limit", statement: "over", usedPercent: 90 }),
        reading({ window: "Sonnet limit", statement: "used", usedPercent: 95 }),
      ])
    ).toMatch(/^Sonnet limit 95% used/);
    // On an equal figure the floor wins even though the other window sorts first.
    expect(
      pick([
        reading({ window: "Opus limit", statement: "used", usedPercent: 90 }),
        reading({ window: "Sonnet limit", statement: "over", usedPercent: 90 }),
      ])
    ).toMatch(/^Sonnet limit over 90% used/);
    // Equal in force, the newer message stands even though the other window sorts first.
    expect(
      pick([
        reading({ window: "Opus limit", usedPercent: 50, observedAt: NOW - 5 * HOUR }),
        reading({ window: "Sonnet limit", usedPercent: 50, observedAt: NOW - HOUR }),
      ])
    ).toMatch(/^Sonnet limit 50% used.* observed 1h ago$/);
    // Equal in everything else, the window order decides, whichever arrives first.
    const same = [
      reading({ window: "Sonnet limit", usedPercent: 50 }),
      reading({ window: "Opus limit", usedPercent: 50 }),
    ];
    expect(pick(same)).toMatch(/^Opus limit 50% used/);
    expect(pick([...same].reverse())).toMatch(/^Opus limit 50% used/);
  });

  it("treats a reset at exactly now as passed, and shows nothing for a login with no readings", () => {
    const edge = claudeAccount({
      accountIds: ["work"],
      readings: [reading({ resetsAt: NOW })],
    });
    expect(accountHeadroom("claude", target, claudeOnly(edge), NOW)?.stale).toBe(true);
    expect(
      accountHeadroom(
        "claude",
        target,
        claudeOnly(claudeAccount({ accountIds: ["work"], readings: [] })),
        NOW
      )
    ).toBeUndefined();
  });

  it("picks the strongest reading: a hit limit, then the highest figure, a floor over an exact one", () => {
    const pick = (readings: ClaudeUsageReading[]) =>
      accountHeadroom(
        "claude",
        target,
        claudeOnly(claudeAccount({ accountIds: ["work"], readings })),
        NOW
      )?.text;
    expect(
      pick([
        reading({ window: "weekly limit", usedPercent: 99 }),
        reading({ window: "5-hour limit", statement: "reached", usedPercent: null }),
      ])
    ).toMatch(/^5-hour limit reached/);
    expect(
      pick([
        reading({ window: "weekly limit", usedPercent: 80 }),
        reading({ window: "Opus limit", statement: "over", usedPercent: 90 }),
      ])
    ).toMatch(/^Opus limit over 90% used/);
    expect(
      pick([
        reading({ window: "Sonnet limit", statement: "used", usedPercent: 90 }),
        reading({ window: "Opus limit", statement: "over", usedPercent: 90 }),
      ])
    ).toMatch(/^Opus limit over 90% used/);
    expect(
      pick([
        reading({ window: "5-hour limit", statement: "approaching", usedPercent: null }),
        reading({ window: "weekly limit", usedPercent: 12 }),
      ])
    ).toMatch(/^Weekly limit 12% used/);
  });

  it("marks a reading whose reset has passed as stale and doesn't hide it", () => {
    const old = claudeAccount({
      accountIds: ["work"],
      readings: [reading({ resetsAt: NOW - HOUR })],
    });
    const headroom = accountHeadroom("claude", target, claudeOnly(old), NOW);
    expect(headroom?.stale).toBe(true);
    expect(headroom?.text).toMatch(/^Stale · Weekly limit 87% used · reset .+ · observed 3h ago$/);
  });

  it("matches a saved account sharing the default folder through the default group", () => {
    const group = claudeAccount({
      kind: "default",
      accountNames: ["Work"],
      accountIds: ["work"],
      readings: [reading({})],
    });
    expect(accountHeadroom("claude", target, claudeOnly(group), NOW)).toBeDefined();
    expect(accountHeadroom("claude", { kind: "default" }, claudeOnly(group), NOW)).toBeDefined();
  });

  it("never gives the default login another folder's reading", () => {
    const other = claudeAccount({ kind: "other", readings: [reading({})] });
    const unknown = claudeAccount({ kind: "unknown", readings: [reading({})] });
    expect(
      accountHeadroom("claude", { kind: "default" }, claudeOnly(other, unknown), NOW)
    ).toBeUndefined();
    const group = claudeAccount({ kind: "default", readings: [reading({})] });
    expect(
      accountHeadroom(
        "claude",
        { kind: "default", presetNamesFolder: true },
        claudeOnly(group),
        NOW
      )
    ).toBeUndefined();
  });

  it("shows nothing before any reading, for an account with none, or for another agent", () => {
    expect(accountHeadroom("claude", target, claudeOnly(), NOW)).toBeUndefined();
    expect(accountHeadroom("claude", target, { codex: null, claude: null }, NOW)).toBeUndefined();
    expect(
      accountHeadroom(
        "gemini",
        target,
        claudeOnly(claudeAccount({ accountIds: ["work"], readings: [reading({})] })),
        NOW
      )
    ).toBeUndefined();
  });
});

describe("presetNamesAccountFolder", () => {
  it("is true when the preset sets the agent's config folder variable, in any case", () => {
    expect(presetNamesAccountFolder("codex", { env: { codex_home: "/x" } })).toBe(true);
    expect(presetNamesAccountFolder("claude", { env: { CLAUDE_CONFIG_DIR: "/x" } })).toBe(true);
  });

  it("is false for a preset that doesn't, no preset, or an agent with no config folder", () => {
    expect(presetNamesAccountFolder("codex", { env: { OTHER: "1" } })).toBe(false);
    expect(presetNamesAccountFolder("codex", { env: { CLAUDE_CONFIG_DIR: "/x" } })).toBe(false);
    expect(presetNamesAccountFolder("codex", undefined)).toBe(false);
    expect(presetNamesAccountFolder("cursor", { env: { CODEX_HOME: "/x" } })).toBe(false);
  });
});
