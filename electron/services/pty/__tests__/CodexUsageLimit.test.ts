import { describe, expect, it } from "vitest";
import type {
  CodexLimitBucketEvidence,
  CodexLimitEvidence,
  CodexLimitWindowEvidence,
} from "../../../../shared/types/codexLimitReset.js";
import {
  codexBannerResetCandidates,
  codexLaunchZone,
  readCodexLimitEvidence,
  resolveCodexLimitReset,
  scanCodexLimitBanner,
  type CodexBannerTime,
  type CodexLimitBanner,
  type CodexLimitObservation,
} from "../CodexUsageLimit.js";

/** Word-wraps a line the way Codex's history does: at spaces, the space eaten, no indent. */
function wrap(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const word of line.split(" ")) {
    if (row !== "" && row.length + 1 + word.length > width) {
      rows.push(row);
      row = word;
    } else {
      row = row === "" ? word : `${row} ${word}`;
    }
  }
  rows.push(row);
  return rows;
}

const COMPOSER = ["", "› Ask Codex to do anything", "", "  gpt-5.5 high · 62% left · ~/repo"];

const bare = (hour: number, minute: number): CodexBannerTime => ({ date: null, hour, minute });

// Messages as `UsageLimitReachedError`'s Display writes them (codex-rs/protocol/src/error.rs).
describe("scanCodexLimitBanner", () => {
  it.each([
    ["no plan", "You’ve hit your usage limit. Try again at 3:40 PM."],
    ["a straight apostrophe", "You've hit your usage limit. Try again at 3:40 PM."],
    [
      "Plus",
      "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:40 PM.",
    ],
    [
      "Business",
      "You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 3:40 PM.",
    ],
    [
      "Free and Go",
      "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:40 PM.",
    ],
    [
      "Pro",
      "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:40 PM.",
    ],
    [
      "a promo",
      "You’ve hit your usage limit. Get 2x usage on Pro this week (https://chatgpt.com/promo), or try again at 3:40 PM.",
    ],
  ])("reads the general banner with %s", (_label, message) => {
    expect(scanCodexLimitBanner([`■ ${message}`, ...COMPOSER])).toEqual({
      kind: "at",
      time: bare(15, 40),
      limitName: null,
    });
  });

  it("reads a dated reset", () => {
    expect(
      scanCodexLimitBanner(["■ You’ve hit your usage limit. Try again at Nov 21st, 2026 3:40 PM."])
    ).toEqual({
      kind: "at",
      time: { date: { year: 2026, month: 10, day: 21 }, hour: 15, minute: 40 },
      limitName: null,
    });
  });

  it("reads noon and midnight", () => {
    const at = (time: string) =>
      scanCodexLimitBanner([`■ You’ve hit your usage limit. Try again at ${time}.`]);
    expect(at("12:05 PM")).toMatchObject({ time: bare(12, 5) });
    expect(at("12:05 AM")).toMatchObject({ time: bare(0, 5) });
  });

  it("reads a long upsell wrapped across rows, with the date split between them", () => {
    const message =
      "■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 22nd, 2026 9:05 AM.";
    const rows = wrap(message, 44);
    expect(rows.length).toBeGreaterThan(4);
    expect(scanCodexLimitBanner([...rows, ...COMPOSER], 44)).toEqual({
      kind: "at",
      time: { date: { year: 2026, month: 10, day: 22 }, hour: 9, minute: 5 },
      limitName: null,
    });
  });

  it("reads a banner the terminal wrapped inside a word", () => {
    const message = "■ You’ve hit your usage limit. Try again at Nov 23rd, 2026 3:40 PM.";
    const rows = [message.slice(0, 50), message.slice(50)];
    expect(rows[0]).toHaveLength(50);
    expect(scanCodexLimitBanner(rows, 50)).toMatchObject({
      kind: "at",
      time: { date: { year: 2026, month: 10, day: 23 } },
    });
  });

  it("reads no reset as later", () => {
    expect(scanCodexLimitBanner(["■ You’ve hit your usage limit. Try again later."])).toEqual({
      kind: "later",
      limitName: null,
    });
    expect(
      scanCodexLimitBanner([
        "■ You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again later.",
      ])
    ).toEqual({ kind: "later", limitName: null });
  });

  it("reads a model bucket's own limit, a dotted name included", () => {
    expect(
      scanCodexLimitBanner([
        "■ You’ve hit your usage limit for GPT-5.5-Codex. Switch to another model now, or try again at 3:40 PM.",
      ])
    ).toEqual({ kind: "at", time: bare(15, 40), limitName: "GPT-5.5-Codex" });
    expect(
      scanCodexLimitBanner(
        wrap(
          "■ You’ve hit your usage limit for GPT-5.5-Codex. Switch to another model now, or try again later.",
          30
        ),
        30
      )
    ).toEqual({ kind: "later", limitName: "GPT-5.5-Codex" });
  });

  it.each([
    "Your workspace is out of credits. Add credits to continue.",
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
  ])("reads a credit or spend-cap stop as having no reset: %s", (message) => {
    expect(scanCodexLimitBanner(wrap(`■ ${message}`, 40), 40)).toEqual({ kind: "no-reset" });
  });

  it("takes the lowest banner", () => {
    expect(
      scanCodexLimitBanner([
        "■ You’ve hit your usage limit. Try again at 3:40 PM.",
        "› continue",
        "■ You’ve hit your usage limit. Try again at Nov 21st, 2026 3:40 PM.",
      ])
    ).toMatchObject({ time: { date: { day: 21 } } });
  });

  it("reads a banner that starts but matches no form as unreadable, not an older one", () => {
    expect(
      scanCodexLimitBanner([
        "■ You’ve hit your usage limit. Try again at 3:40 PM.",
        "› continue",
        "■ You’ve hit your usage limit. Try again at 13:40 PM.",
      ])
    ).toEqual({ kind: "unreadable" });
    expect(
      scanCodexLimitBanner(["■ You’ve hit your usage limit. Try again at Nov 21th, 2026 3:40 PM."])
    ).toEqual({ kind: "unreadable" });
    expect(
      scanCodexLimitBanner(["You’ve hit your usage limit. Try again at 3:40 PM. Odd."])
    ).toEqual({ kind: "unreadable" });
  });

  it("reads another error behind the marker as no banner, and finds the stop above it", () => {
    expect(scanCodexLimitBanner(["■ stream disconnected before completion"])).toBeNull();
    expect(
      scanCodexLimitBanner([
        "■ You’ve hit your usage limit. Try again at 3:40 PM.",
        "› continue",
        "■ stream disconnected before completion",
      ])
    ).toMatchObject({ kind: "at" });
  });

  it("reads a banner whose opener the pane wrapped", () => {
    expect(
      scanCodexLimitBanner(wrap("■ You’ve hit your usage limit. Try again at 3:40 PM.", 16), 16)
    ).toMatchObject({ kind: "at", time: bare(15, 40) });
  });

  it.each([
    ["an agent reply", ["• You’ve hit your usage limit. Try again at 3:40 PM."]],
    ["an indented row", ["  You’ve hit your usage limit. Try again at 3:40 PM."]],
    ["a question", ["Have you hit your usage limit? Try again at 3:40 PM."]],
  ])("reads %s as no banner", (_label, lines) => {
    expect(scanCodexLimitBanner(lines)).toBeNull();
  });

  it("reads a banner scrolled above the tail as old news", () => {
    const filler = Array.from({ length: 12 }, (_, i) => `• step ${i}`);
    expect(
      scanCodexLimitBanner(["■ You’ve hit your usage limit. Try again at 3:40 PM.", ...filler])
    ).toBeNull();
  });

  it("strips ANSI color", () => {
    expect(
      scanCodexLimitBanner(["\x1b[31m■ You’ve hit your usage limit. Try again at 3:40 PM.\x1b[39m"])
    ).toMatchObject({ kind: "at" });
  });
});

describe("codexBannerResetCandidates", () => {
  // 2026-11-19 10:00 in New York (EST, UTC-5).
  const nyMorning = Date.UTC(2026, 10, 19, 15, 0);
  const SECOND = 1_000;
  const candidates = (time: CodexBannerTime, seenAt: number, zone: string, printedAfter?: number) =>
    codexBannerResetCandidates(time, seenAt, printedAfter ?? seenAt - SECOND, zone);

  it("reads a bare time on the day the banner was seen", () => {
    expect(candidates(bare(15, 40), nyMorning, "America/New_York")).toEqual([
      Date.UTC(2026, 10, 19, 20, 40),
    ]);
  });

  it("never rolls a bare time to tomorrow", () => {
    // Seen at 16:00 just after it printed: 3:40 PM had already passed, which Codex never prints.
    const afternoon = Date.UTC(2026, 10, 19, 21, 0);
    expect(candidates(bare(15, 40), afternoon, "America/New_York")).toEqual([]);
    // Seen at 16:00 after a look at 15:00, it may have printed before 3:40 PM.
    expect(
      candidates(bare(15, 40), afternoon, "America/New_York", Date.UTC(2026, 10, 19, 20, 0))
    ).toEqual([Date.UTC(2026, 10, 19, 20, 40)]);
  });

  it("reads a dated reset on its own day", () => {
    const time = { date: { year: 2026, month: 10, day: 21 }, hour: 15, minute: 40 };
    expect(candidates(time, nyMorning, "America/New_York")).toEqual([
      Date.UTC(2026, 10, 21, 20, 40),
    ]);
  });

  it("reads the time in the zone it is given, whatever this machine's is", () => {
    // 10:00 New York is 00:00 next day in Tokyo, so 3:40 PM there is the 20th's.
    expect(candidates(bare(15, 40), nyMorning, "Asia/Tokyo")).toEqual([
      Date.UTC(2026, 10, 20, 6, 40),
    ]);
  });

  it("offers each day a banner could have printed on when the look before it crossed midnight", () => {
    // Seen at 00:01 New York on the 20th, last looked at 23:58 on the 19th.
    const justAfterMidnight = Date.UTC(2026, 10, 20, 5, 1);
    const lookBefore = Date.UTC(2026, 10, 20, 4, 58);
    expect(candidates(bare(23, 59), justAfterMidnight, "America/New_York", lookBefore)).toEqual([
      Date.UTC(2026, 10, 20, 4, 59),
      Date.UTC(2026, 10, 21, 4, 59),
    ]);
    expect(candidates(bare(23, 59), justAfterMidnight, "America/New_York")).toEqual([
      Date.UTC(2026, 10, 21, 4, 59),
    ]);
  });

  it("offers both showings of a time in a fold, dropping one already past", () => {
    // New York falls back at 2:00 EDT on 2026-11-01: 1:30 shows at 05:30Z and 06:30Z.
    const beforeFold = Date.UTC(2026, 10, 1, 4, 50);
    expect(candidates(bare(1, 30), beforeFold, "America/New_York")).toEqual([
      Date.UTC(2026, 10, 1, 5, 30),
      Date.UTC(2026, 10, 1, 6, 30),
    ]);
    const inSecondPass = Date.UTC(2026, 10, 1, 6, 10);
    expect(candidates(bare(1, 30), inSecondPass, "America/New_York")).toEqual([
      Date.UTC(2026, 10, 1, 6, 30),
    ]);
  });

  it("reads a time the zone's clock skips as none", () => {
    // New York springs forward at 2:00 EST on 2026-03-08.
    expect(candidates(bare(2, 30), Date.UTC(2026, 2, 8, 5, 0), "America/New_York")).toEqual([]);
  });

  it("answers null for a zone it can't read", () => {
    expect(candidates(bare(15, 40), nyMorning, "Not/AZone")).toBeNull();
  });
});

describe("codexLaunchZone", () => {
  it("is this process's zone when neither the launch nor this process names one", () => {
    expect(codexLaunchZone({}, "darwin", undefined)).toBeUndefined();
  });

  it("won't take this process's zone for the system's when it has a TZ of its own", () => {
    expect(codexLaunchZone({}, "linux", "Asia/Tokyo")).toBeNull();
    expect(codexLaunchZone({ TZ: "Asia/Tokyo" }, "win32", "Asia/Tokyo")).toBeNull();
  });

  it.each([
    ["Asia/Tokyo", "Asia/Tokyo"],
    [":Europe/Paris", "Europe/Paris"],
    ["/usr/share/zoneinfo/Europe/Paris", "Europe/Paris"],
    [":/usr/share/zoneinfo/America/New_York", "America/New_York"],
    ["", "UTC"],
  ])("reads TZ=%j as %s", (tz, zone) => {
    expect(codexLaunchZone({ TZ: tz }, "linux", undefined)).toBe(zone);
  });

  it.each([":", "CET-1CEST,M3.5.0,M10.5.0/3", "/etc/localtime", "Not/AZone"])(
    "won't guess TZ=%j",
    (tz) => {
      expect(codexLaunchZone({ TZ: tz }, "darwin", undefined)).toBeNull();
    }
  );

  it("ignores TZ on Windows, as Codex does", () => {
    expect(codexLaunchZone({ TZ: "Asia/Tokyo" }, "win32", undefined)).toBeUndefined();
  });
});

describe("resolveCodexLimitReset", () => {
  const MINUTE = 60_000;
  const seenAt = Date.UTC(2026, 10, 19, 15, 0);
  const fiveHourReset = Date.UTC(2026, 10, 19, 20, 40);
  const weeklyReset = Date.UTC(2026, 10, 21, 20, 40);

  const observation = (
    banner: CodexLimitBanner,
    candidates: number[] | null = [fiveHourReset],
    attributed = true
  ): CodexLimitObservation => ({ banner, observedAt: seenAt, candidates, attributed });
  const at = (limitName: string | null = null): CodexLimitBanner => ({
    kind: "at",
    time: bare(15, 40),
    limitName,
  });
  const later = (limitName: string | null = null): CodexLimitBanner => ({
    kind: "later",
    limitName,
  });
  const bucket = (
    limitId: string | null,
    windows: CodexLimitWindowEvidence[],
    limitName: string | null = null,
    unreadable = false
  ): CodexLimitBucketEvidence => ({ limitId, limitName, windows, unreadable });
  const spent = (resetsAt: number | null): CodexLimitWindowEvidence => ({
    usedPercent: 100,
    resetsAt,
  });
  const healthy = (resetsAt: number): CodexLimitWindowEvidence => ({ usedPercent: 40, resetsAt });
  const reading = (...buckets: CodexLimitBucketEvidence[]): CodexLimitEvidence => ({
    requestedAt: seenAt + 5_000,
    buckets,
  });

  it("answers a credit or spend-cap stop as having no reset, whatever the reading", () => {
    expect(
      resolveCodexLimitReset(
        observation({ kind: "no-reset" }),
        reading(bucket("codex", [spent(fiveHourReset)]))
      )
    ).toEqual({ status: "unknown", reason: "no-reset", observedAt: seenAt });
  });

  it("answers from the banner alone with the end of its minute", () => {
    expect(resolveCodexLimitReset(observation(at()), null)).toEqual({
      status: "known",
      resetsAt: fiveHourReset + MINUTE,
      precision: "minute",
      source: "banner",
      observedAt: seenAt,
    });
  });

  it("takes the reading's exact second for the window the banner names", () => {
    const exact = fiveHourReset + 42_000;
    expect(
      resolveCodexLimitReset(
        observation(at()),
        reading(bucket("codex", [spent(exact), healthy(weeklyReset)]))
      )
    ).toMatchObject({ status: "known", resetsAt: exact, precision: "second", source: "quota" });
  });

  it("takes the later reset when two windows are spent", () => {
    expect(
      resolveCodexLimitReset(
        observation(at()),
        reading(bucket("codex", [spent(fiveHourReset + 10_000), spent(weeklyReset)]))
      )
    ).toMatchObject({ status: "known", resetsAt: weeklyReset, source: "quota" });
  });

  it("never stretches the answer with a spent model bucket the banner doesn't name", () => {
    const result = resolveCodexLimitReset(
      observation(at()),
      reading(
        bucket("codex", [spent(fiveHourReset), healthy(weeklyReset)]),
        bucket("codex_bengalfox", [spent(weeklyReset + 86_400_000)], "GPT-5.5-Codex")
      )
    );
    expect(result).toMatchObject({ status: "known", resetsAt: fiveHourReset });
  });

  it("reads a model limit against the bucket of the name it printed", () => {
    const result = resolveCodexLimitReset(
      observation(at("GPT-5.5-Codex")),
      reading(
        bucket("codex", [spent(weeklyReset + 86_400_000)]),
        bucket("codex_other", [spent(fiveHourReset + 1_000)], "Other"),
        bucket("codex_bengalfox", [spent(fiveHourReset), spent(weeklyReset)], "GPT-5.5-Codex")
      )
    );
    expect(result).toMatchObject({ status: "known", resetsAt: weeklyReset });
  });

  it("answers a model limit from the banner when no bucket of that name was read", () => {
    expect(
      resolveCodexLimitReset(
        observation(at("GPT-5.5-Codex")),
        reading(bucket("codex", [spent(weeklyReset)]))
      )
    ).toMatchObject({ status: "known", resetsAt: fiveHourReset + MINUTE, source: "banner" });
  });

  it("answers unknown when the reading shows no spent window at the banner's time", () => {
    expect(
      resolveCodexLimitReset(
        observation(at()),
        reading(bucket("codex", [spent(fiveHourReset + 3 * MINUTE)]))
      )
    ).toEqual({ status: "unknown", reason: "quota-disagrees", observedAt: seenAt });
    // A healthy window that happens to reset that minute is no confirmation either.
    expect(
      resolveCodexLimitReset(observation(at()), reading(bucket("codex", [healthy(fiveHourReset)])))
    ).toMatchObject({ status: "unknown", reason: "quota-disagrees" });
  });

  it("answers unknown when the reading can't say all it needs to", () => {
    expect(
      resolveCodexLimitReset(
        observation(at()),
        reading(bucket("codex", [spent(fiveHourReset), spent(null)]))
      )
    ).toMatchObject({ status: "unknown", reason: "quota-incomplete" });
    expect(
      resolveCodexLimitReset(observation(at()), reading(bucket("codex", [], null, true)))
    ).toMatchObject({ status: "unknown", reason: "quota-incomplete" });
  });

  it("answers unknown when the ordinary and reserve buckets both fit and differ", () => {
    expect(
      resolveCodexLimitReset(
        observation(at()),
        reading(
          bucket("codex", [spent(fiveHourReset), spent(weeklyReset)]),
          bucket("gpt-reserve", [spent(fiveHourReset + 5_000)])
        )
      )
    ).toMatchObject({ status: "unknown", reason: "ambiguous-bucket" });
  });

  it("lets a reading pick between the two showings of a fold, and answers unknown when none does", () => {
    const first = Date.UTC(2026, 10, 1, 5, 30);
    const second = Date.UTC(2026, 10, 1, 6, 30);
    const fold: CodexLimitObservation = {
      banner: { kind: "at", time: bare(1, 30), limitName: null },
      observedAt: Date.UTC(2026, 10, 1, 4, 55),
      candidates: [first, second],
      attributed: true,
    };
    const asked = { requestedAt: Date.UTC(2026, 10, 1, 4, 56) };
    expect(
      resolveCodexLimitReset(fold, {
        ...asked,
        buckets: [bucket("codex", [spent(second + 7_000)])],
      })
    ).toMatchObject({ status: "known", resetsAt: second + 7_000 });
    expect(resolveCodexLimitReset(fold, null)).toMatchObject({
      status: "unknown",
      reason: "ambiguous-time",
    });
    // Read after the first showing passed, a spent window at the second can't rule the first out.
    const late = { requestedAt: Date.UTC(2026, 10, 1, 6, 5) };
    expect(
      resolveCodexLimitReset(fold, {
        ...late,
        buckets: [bucket("codex", [healthy(second + 12_000)])],
      })
    ).toMatchObject({ status: "unknown", reason: "quota-disagrees" });
  });

  it("ignores a reading asked for before the banner showed", () => {
    const early = { requestedAt: seenAt - 1_000, buckets: [bucket("codex", [spent(weeklyReset)])] };
    expect(resolveCodexLimitReset(observation(at()), early)).toMatchObject({
      status: "known",
      resetsAt: fiveHourReset + MINUTE,
      source: "banner",
    });
    expect(resolveCodexLimitReset(observation(later()), early)).toMatchObject({
      status: "unknown",
      reason: "no-reset-stated",
    });
  });

  it("keeps the banner's own time once it passed before the reading", () => {
    const afterReset = {
      requestedAt: fiveHourReset + 2 * MINUTE,
      buckets: [bucket("codex", [spent(weeklyReset)])],
    };
    expect(resolveCodexLimitReset(observation(at()), afterReset)).toMatchObject({
      status: "known",
      resetsAt: fiveHourReset + MINUTE,
      source: "banner",
    });
  });

  it("resolves try-again-later only from a timely reading of the pane's spent bucket", () => {
    expect(resolveCodexLimitReset(observation(later()), null)).toMatchObject({
      status: "unknown",
      reason: "no-reset-stated",
    });
    expect(
      resolveCodexLimitReset(observation(later()), reading(bucket("codex", [healthy(weeklyReset)])))
    ).toMatchObject({ status: "unknown", reason: "no-reset-stated" });
    expect(
      resolveCodexLimitReset(
        observation(later()),
        reading(bucket("codex", [spent(fiveHourReset), spent(weeklyReset)]))
      )
    ).toMatchObject({ status: "known", resetsAt: weeklyReset, source: "quota" });
    const stale = {
      requestedAt: seenAt + 60 * MINUTE,
      buckets: [bucket("codex", [spent(weeklyReset)])],
    };
    expect(resolveCodexLimitReset(observation(later()), stale)).toMatchObject({
      status: "unknown",
      reason: "no-reset-stated",
    });
  });

  it("answers unknown for a Codex it can't tie to the launch, or a time it can't read", () => {
    expect(resolveCodexLimitReset(observation(at(), [fiveHourReset], false), null)).toMatchObject({
      reason: "unattributed",
    });
    expect(resolveCodexLimitReset(observation(at(), null), null)).toMatchObject({
      reason: "zone-unknown",
    });
    expect(resolveCodexLimitReset(observation(at(), []), null)).toMatchObject({
      reason: "unreadable-time",
    });
    expect(resolveCodexLimitReset(observation({ kind: "unreadable" }), null)).toMatchObject({
      reason: "unreadable-banner",
    });
  });
});

describe("readCodexLimitEvidence", () => {
  it("keeps evidence and refuses anything else", () => {
    const evidence = {
      requestedAt: 1,
      buckets: [
        {
          limitId: "codex",
          limitName: null,
          windows: [{ usedPercent: 100, resetsAt: 5 }],
          unreadable: false,
        },
      ],
    };
    expect(readCodexLimitEvidence(evidence)).toEqual(evidence);
    expect(readCodexLimitEvidence(null)).toBeNull();
    expect(readCodexLimitEvidence({ requestedAt: 1, buckets: [{ windows: "x" }] })).toBeNull();
  });
});
