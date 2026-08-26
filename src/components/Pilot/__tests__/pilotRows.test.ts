import { describe, expect, it } from "vitest";
import {
  bandFilterHasDemand,
  buildPilotGroups,
  buildPilotWorktreeGroups,
  hasWorktreeAxis,
  countPilotBands,
  filterPilotBands,
  filterPilotGroups,
  summarizePilotGroups,
  PILOT_BAND_FILTER_LABEL,
  type PilotRowContext,
} from "../pilotRows";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import {
  bandForRun,
  bandLabel,
  emptyBandCounts,
  FLEET_BANDS,
  type FleetBand,
} from "@/lib/fleetAttention";

const NOW = 1_700_000_000_000;

function run(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/Users/dev/daintree-worktrees/issue-11518-scratch-rows",
    ...overrides,
  };
}

function ctx(overrides: Partial<PilotRowContext> = {}): PilotRowContext {
  return {
    workspaces: new Map([["p1", { kind: "project", name: "daintree", emoji: "🌳" }]]),
    currentWorkspaceId: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe("buildPilotGroups", () => {
  it("labels a row with the panel title, worktree and agent", () => {
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "waiting",
          agentId: "claude",
          title: "Fix the palette wait-age tick",
          since: NOW - 120_000,
        }),
      ],
      ctx()
    );
    const row = group!.rows[0]!;

    expect(row.title).toBe("Fix the palette wait-age tick");
    expect(row.worktreeLabel).toBe("issue-11518-scratch-rows");
    expect(row.age).toBe("2m");
    // Identity rides an icon, not a text label — the same trade the tab strip's
    // compact title makes, and why the agent's name is not in the detail line.
    expect(row.chrome.agentId).toBe("claude");
    expect(row.chrome.iconId).toBe("claude");
  });

  it("drops a task the agent can no longer be running", () => {
    // Raw passthrough kept the last OSC title forever, so an exited agent went
    // on advertising work that had stopped. The pipeline ties tasks to a live
    // agent and falls back to identity once it is gone.
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "exited",
          agentId: "claude",
          title: "Claude",
          lastObservedTitle: "Fix the auth redirect",
        }),
      ],
      ctx()
    );

    expect(group!.rows[0]!.title).toBe("Claude");
  });

  it("ignores an OSC title that just names the folder the agent is in", () => {
    // Codex idles with its cwd as the title. Where an agent is, is not what it
    // is doing — and the row already says where.
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "working",
          agentId: "claude",
          title: "Claude",
          cwd: "/Users/dev/daintree-worktrees/pilot-mode",
          lastObservedTitle: "pilot-mode",
        }),
      ],
      ctx()
    );

    expect(group!.rows[0]!.title).toBe("Claude");
  });

  it("prefers the agent's live task over the panel's identity title", () => {
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "working",
          agentId: "claude",
          title: "Claude",
          lastObservedTitle: "Fix the auth redirect",
        }),
      ],
      ctx()
    );

    expect(group!.rows[0]!.title).toBe("Fix the auth redirect");
  });

  it("never lets a task override a title the user set by hand", () => {
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "working",
          agentId: "claude",
          title: "Release prep",
          titleMode: "user",
          lastObservedTitle: "Fix the auth redirect",
        }),
      ],
      ctx()
    );

    expect(group!.rows[0]!.title).toBe("Release prep");
  });

  it("falls back to the agent name when the run has no title", () => {
    const [group] = buildPilotGroups([run({ agentState: "working", agentId: "claude" })], ctx());

    // Never an empty cell — the row still has to say what it is.
    expect(group!.rows[0]!.title).toBe("Claude");
  });

  it("falls back again when neither a title nor an agent name is known", () => {
    const [group] = buildPilotGroups([run({ agentState: "working" })], ctx());

    expect(group!.rows[0]!.title.trim().length).toBeGreaterThan(0);
  });

  it("treats a whitespace-only title as absent", () => {
    const [group] = buildPilotGroups(
      [run({ agentState: "working", agentId: "claude", title: "   " })],
      ctx()
    );

    expect(group!.rows[0]!.title).toBe("Claude");
  });

  it("carries the project name and emoji onto the group", () => {
    const [group] = buildPilotGroups([run({ agentState: "working" })], ctx());

    expect(group!.name).toBe("daintree");
    expect(group!.emoji).toBe("🌳");
  });

  it("still renders a run whose workspace is no longer in the store", () => {
    // Dropping it would hide a live agent because a name lookup missed.
    const [group] = buildPilotGroups(
      [run({ runId: "orphan", workspaceId: "gone", agentState: "waiting" })],
      ctx()
    );

    expect(group!.rows[0]!.run.runId).toBe("orphan");
    expect(group!.name.trim().length).toBeGreaterThan(0);
    expect(group!.name).not.toBe("gone");
  });

  it("drops a worktree label that only repeats the project name", () => {
    const [group] = buildPilotGroups(
      [run({ agentState: "working", cwd: "/Users/dev/Projects/Daintree/daintree" })],
      ctx({ workspaces: new Map([["p1", { kind: "project", name: "Daintree" }]]) })
    );

    expect(group!.rows[0]!.worktreeLabel).toBeNull();
  });

  it("keeps a worktree label that genuinely differs from the project", () => {
    const [group] = buildPilotGroups(
      [run({ agentState: "working", cwd: "/Users/dev/daintree-worktrees/pilot-mode" })],
      ctx({ workspaces: new Map([["p1", { kind: "project", name: "Daintree" }]]) })
    );

    expect(group!.rows[0]!.worktreeLabel).toBe("pilot-mode");
  });

  it("groups runs under the project that owns them", () => {
    const groups = buildPilotGroups(
      [
        run({ runId: "a", workspaceId: "p1", agentState: "working" }),
        run({ runId: "b", workspaceId: "p2", agentState: "working" }),
        run({ runId: "c", workspaceId: "p1", agentState: "working" }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "alpha" }],
          ["p2", { kind: "project", name: "beta" }],
        ]),
      })
    );

    expect(groups).toHaveLength(2);
    const alpha = groups.find((g) => g.name === "alpha")!;
    expect(alpha.rows.map((r) => r.run.runId).sort()).toEqual(["a", "c"]);
  });

  it("orders projects by last opened, not by worst band", () => {
    const groups = buildPilotGroups(
      [
        run({
          runId: "b",
          workspaceId: "aa-stale",
          agentState: "waiting",
          waitingReason: "error",
          since: NOW,
        }),
        run({ runId: "w", workspaceId: "zz-fresh", agentState: "working", since: NOW }),
      ],
      ctx({
        workspaces: new Map([
          // Name, band, arrival order and workspace id would ALL put the stale
          // project first. Only recency lifts the just-opened one over it.
          ["aa-stale", { kind: "project", name: "aaa", lastOpened: NOW - 3_600_000 }],
          ["zz-fresh", { kind: "project", name: "zzz", lastOpened: NOW }],
        ]),
      })
    );

    expect(groups.map((g) => g.name)).toEqual(["zzz", "aaa"]);
  });

  it("puts the project just opened above another project's waiting agents", () => {
    // The reported case (#11678): the current project held one working agent and
    // rendered below a project holding four waiting ones, because waiting
    // outranked everything at group level. Only the opening times differ between
    // the two calls, so the flip is proof recency is what decides.
    const fleet = (groundwork: number, pixel: number) =>
      buildPilotGroups(
        [
          run({ runId: "gt", workspaceId: "gt", agentState: "working", since: NOW }),
          ...["a", "b", "c", "d"].map((id) =>
            run({
              runId: `px-${id}`,
              workspaceId: "px",
              agentState: "waiting",
              since: NOW - 600_000,
            })
          ),
        ],
        ctx({
          currentWorkspaceId: "gt",
          workspaces: new Map([
            ["gt", { kind: "project", name: "Groundwork Terrain", lastOpened: groundwork }],
            ["px", { kind: "project", name: "Pixel Reconstruct", lastOpened: pixel }],
          ]),
        })
      ).map((g) => g.name);

    expect(fleet(NOW, NOW - 86_400_000)).toEqual(["Groundwork Terrain", "Pixel Reconstruct"]);
    expect(fleet(NOW - 86_400_000, NOW)).toEqual(["Pixel Reconstruct", "Groundwork Terrain"]);
  });

  it("orders a mixed fleet strictly newest-opened first", () => {
    const groups = buildPilotGroups(
      [
        run({
          runId: "a",
          workspaceId: "old",
          agentState: "waiting",
          waitingReason: "error",
          since: NOW,
        }),
        run({ runId: "b", workspaceId: "mid", agentState: "working", since: NOW }),
        run({ runId: "c", workspaceId: "new", agentState: "exited" }),
      ],
      ctx({
        workspaces: new Map([
          // Both name and band run opposite to the opening times, so neither can
          // be what produces the expected order.
          ["old", { kind: "project", name: "aaa", lastOpened: NOW - 86_400_000 }],
          ["mid", { kind: "scratch", name: "mmm", lastOpened: NOW - 3_600_000 }],
          ["new", { kind: "project", name: "zzz", lastOpened: NOW }],
        ]),
      })
    );

    expect(groups.map((g) => g.name)).toEqual(["zzz", "mmm", "aaa"]);
  });

  it("breaks an equal last-opened tie by name", () => {
    const groups = buildPilotGroups(
      [
        // Arrival order and workspace id both favour "beta", so only the name
        // tiebreak can produce the expected order.
        run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW }),
        run({ runId: "b", workspaceId: "p2", agentState: "working", since: NOW }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "beta", lastOpened: NOW }],
          ["p2", { kind: "project", name: "alpha", lastOpened: NOW }],
        ]),
      })
    );

    expect(groups.map((g) => g.name)).toEqual(["alpha", "beta"]);
  });

  it("sinks a workspace it cannot date below every dated one, without dropping it", () => {
    // A run whose workspace has left the store still has to render. Ranking it
    // is a separate question: an absent opening time is not evidence of a recent
    // one, so it settles at the bottom rather than displacing a real history.
    // Named so a name fallback would put the unknown group first instead.
    const groups = buildPilotGroups(
      [
        run({ runId: "orphan", workspaceId: "gone", agentState: "waiting", since: NOW }),
        run({ runId: "known", workspaceId: "p1", agentState: "working", since: NOW }),
      ],
      ctx({
        workspaces: new Map([["p1", { kind: "project", name: "zzz", lastOpened: NOW - 600_000 }]]),
      })
    );

    expect(groups.map((g) => g.name)).toEqual(["zzz", "Unknown workspace"]);
    expect(groups[1]!.rows.map((r) => r.run.runId)).toEqual(["orphan"]);
  });

  it("does not let run activity times reorder project groups", () => {
    // Group order is workspace recency, which only a switch advances. An agent
    // starting or blocking must not reshuffle the projects under the cursor.
    // Name, arrival order and workspace id all favour "alpha", so only recency
    // can put "beta" first — and it has to do so whichever way the runs age.
    const quiet = (betaSince: number, alphaSince: number) =>
      buildPilotGroups(
        [
          run({ runId: "b", workspaceId: "a-quiet", agentState: "working", since: alphaSince }),
          run({ runId: "a", workspaceId: "z-busy", agentState: "working", since: betaSince }),
        ],
        ctx({
          workspaces: new Map([
            ["z-busy", { kind: "project", name: "beta", lastOpened: NOW }],
            ["a-quiet", { kind: "project", name: "alpha", lastOpened: NOW - 600_000 }],
          ]),
        })
      ).map((g) => g.name);

    expect(quiet(NOW - 600_000, NOW)).toEqual(["beta", "alpha"]);
    expect(quiet(NOW, NOW - 600_000)).toEqual(["beta", "alpha"]);
  });

  it("treats an unusable opening time as undateable instead of breaking the order", () => {
    // `Infinity - Infinity` is NaN, and a NaN comparator result reads as "these
    // two are equal" against everything it touches, so the sort quietly stops
    // being transitive and the same fleet opens two different ways.
    const fleet = (runs: Parameters<typeof buildPilotGroups>[0]) =>
      buildPilotGroups(
        runs,
        ctx({
          workspaces: new Map([
            ["w-inf", { kind: "project", name: "aaa", lastOpened: Number.POSITIVE_INFINITY }],
            ["w-nan", { kind: "project", name: "bbb", lastOpened: Number.NaN }],
            ["w-real", { kind: "project", name: "zzz", lastOpened: NOW }],
          ]),
        })
      ).map((g) => g.name);

    const runs = [
      run({ runId: "a", workspaceId: "w-inf", agentState: "working", since: NOW }),
      run({ runId: "b", workspaceId: "w-nan", agentState: "working", since: NOW }),
      run({ runId: "c", workspaceId: "w-real", agentState: "working", since: NOW }),
    ];

    // The one real timestamp leads despite sorting last by name, and the two
    // unusable ones settle by name the same way whichever order they arrive in.
    expect(fleet(runs)).toEqual(["zzz", "aaa", "bbb"]);
    expect(fleet([...runs].reverse())).toEqual(["zzz", "aaa", "bbb"]);
  });

  it("does not use the current workspace to break an equal-recency tie", () => {
    // Being the workspace asking is not evidence of recency — `lastOpened`
    // already carries that, and under write suppression a switch can leave it
    // unmoved, so context must not buy a position the timestamp does not.
    const groups = buildPilotGroups(
      [
        // Being current, arriving first and holding the lower workspace id all
        // point at "zeta", so only the name tiebreak explains the result.
        run({ runId: "b", workspaceId: "a-here", agentState: "working", since: NOW }),
        run({ runId: "a", workspaceId: "z-there", agentState: "working", since: NOW }),
      ],
      ctx({
        currentWorkspaceId: "a-here",
        workspaces: new Map([
          ["z-there", { kind: "project", name: "alpha", lastOpened: NOW }],
          ["a-here", { kind: "project", name: "zeta", lastOpened: NOW }],
        ]),
      })
    );

    expect(groups.map((g) => g.name)).toEqual(["alpha", "zeta"]);
    // Still marked as the current workspace — it just does not buy position.
    expect(groups.find((g) => g.name === "zeta")!.isCurrent).toBe(true);
  });

  it("orders two identically named projects the same way whatever order they arrive in", () => {
    // Two checkouts of one repo, or a scratch sharing a project's name, is
    // ordinary. Without a final tiebreak the comparator stops being a total
    // order and "the same fleet opens the same way" quietly becomes false.
    const named = (runs: Parameters<typeof buildPilotGroups>[0]) =>
      buildPilotGroups(
        runs,
        ctx({
          workspaces: new Map([
            ["p1", { kind: "project", name: "same", lastOpened: NOW }],
            ["p2", { kind: "project", name: "same", lastOpened: NOW }],
          ]),
        })
      ).map((g) => g.workspaceId);

    const forward = named([
      run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW }),
      run({ runId: "b", workspaceId: "p2", agentState: "working", since: NOW }),
    ]);
    const backward = named([
      run({ runId: "b", workspaceId: "p2", agentState: "working", since: NOW }),
      run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW }),
    ]);

    expect(forward).toEqual(backward);
  });

  it("orders rows inside a project worst-first, then oldest-first", () => {
    const [group] = buildPilotGroups(
      [
        run({ runId: "working", agentState: "working", since: NOW - 1000 }),
        run({ runId: "fresh-wait", agentState: "waiting", since: NOW - 60_000 }),
        run({ runId: "stale-wait", agentState: "waiting", since: NOW - 40 * 60_000 }),
        run({ runId: "blocked", agentState: "waiting", waitingReason: "error", since: NOW }),
      ],
      ctx()
    );

    expect(group!.rows.map((r) => r.run.runId)).toEqual([
      "blocked",
      "stale-wait",
      "fresh-wait",
      "working",
    ]);
  });

  it("counts only demands in a project's demand tally", () => {
    const [group] = buildPilotGroups(
      [
        run({ runId: "a", agentState: "waiting", since: NOW }),
        run({ runId: "b", agentState: "completed", since: NOW }),
        run({ runId: "c", agentState: "working", since: NOW }),
        run({ runId: "d", agentState: "idle", since: NOW }),
      ],
      ctx()
    );

    expect(group!.demandCount).toBe(2);
    expect(group!.rows).toHaveLength(4);
  });

  it("returns nothing for an empty fleet", () => {
    expect(buildPilotGroups([], ctx())).toEqual([]);
  });

  it("ages every row against one shared clock", () => {
    const [group] = buildPilotGroups(
      [
        run({ runId: "a", agentState: "waiting", since: NOW - 60_000 }),
        run({ runId: "b", agentState: "waiting", since: NOW - 3_600_000 }),
      ],
      ctx({ nowMs: NOW })
    );

    expect(group!.rows.map((r) => r.age)).toEqual(["1h", "1m"]);
  });

  it("stops counting a completion the workspace has already acknowledged", () => {
    const seen = buildPilotGroups(
      [run({ agentState: "completed", since: NOW - 60_000 })],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "daintree", lastCompletionSeenAt: NOW }],
        ]),
      })
    );
    expect(seen[0]!.demandCount).toBe(0);
    expect(seen[0]!.rows[0]!.band).toBe("done");

    const unseen = buildPilotGroups(
      [run({ agentState: "completed", since: NOW })],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "daintree", lastCompletionSeenAt: NOW - 60_000 }],
        ]),
      })
    );
    expect(unseen[0]!.demandCount).toBe(1);
  });

  it("acknowledges per workspace rather than fleet-wide", () => {
    const groups = buildPilotGroups(
      [
        run({ runId: "a", workspaceId: "p1", agentState: "completed", since: NOW - 60_000 }),
        run({ runId: "b", workspaceId: "p2", agentState: "completed", since: NOW - 60_000 }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "seen", lastCompletionSeenAt: NOW }],
          ["p2", { kind: "project", name: "unseen" }],
        ]),
      })
    );

    const byName = new Map(groups.map((g) => [g.name, g.demandCount]));
    expect(byName.get("seen")).toBe(0);
    expect(byName.get("unseen")).toBe(1);
  });

  it("carries the workspace kind so a scratch is not drawn as a project", () => {
    // A scratch has no emoji and no colour, so the project tile renders as an
    // empty coloured square unless the row knows what it is looking at.
    const groups = buildPilotGroups(
      [
        run({ runId: "a", workspaceId: "p1", agentState: "working" }),
        run({ runId: "b", workspaceId: "s1", agentState: "working" }),
        run({ runId: "c", workspaceId: "ghost", agentState: "working" }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "daintree", emoji: "🌳" }],
          ["s1", { kind: "scratch", name: "spike" }],
        ]),
      })
    );

    const kinds = new Map(groups.map((g) => [g.name, g.kind]));
    expect(kinds.get("daintree")).toBe("project");
    expect(kinds.get("spike")).toBe("scratch");
    // A workspace removed while its agents kept running is a real anomaly and
    // is allowed to look like one rather than being dropped or faked.
    expect(kinds.get("Unknown workspace")).toBe("unknown");
  });

  it("marks only the workspace this view owns as current", () => {
    const groups = buildPilotGroups(
      [
        run({ runId: "a", workspaceId: "p1", agentState: "working" }),
        run({ runId: "b", workspaceId: "p2", agentState: "working" }),
      ],
      ctx({
        currentWorkspaceId: "p2",
        workspaces: new Map([
          ["p1", { kind: "project", name: "one" }],
          ["p2", { kind: "project", name: "two" }],
        ]),
      })
    );

    expect(groups.filter((g) => g.isCurrent).map((g) => g.name)).toEqual(["two"]);
  });
});

describe("filterPilotGroups", () => {
  const groups = () =>
    buildPilotGroups(
      [
        run({ runId: "a", agentState: "working", title: "fleet snapshot service" }),
        run({ runId: "b", agentState: "working", title: "auth refactor" }),
      ],
      ctx()
    );

  it("accepts an abbreviation anchored to the words it came from", () => {
    // Typing "fltsnp" for "fleet snapshot" works in the project switcher, and a
    // query that abbreviates by word has to keep working here too. The floors
    // themselves differ on purpose — the switcher can afford a weak match
    // because it ranks one, and this surface cannot because it does not.
    const [group] = filterPilotGroups(groups(), "fltsnp");
    expect(group!.rows.map((r) => r.run.runId)).toEqual(["a"]);
  });

  it("drops a row the query only reaches as a scattered subsequence", () => {
    // "rust" is a legal ordered subsequence of the research title, but its
    // characters are so far apart that the words it does land on cannot pay for
    // the distance. Unranked filtering has no bottom of the list to put that in,
    // so it would read as an answer beside the real one (#11625).
    const filtered = filterPilotGroups(
      buildPilotGroups(
        [
          run({
            runId: "loose",
            agentState: "working",
            title: "Research file browser folder selection usability",
          }),
          run({ runId: "exact", agentState: "working", title: "Rust migration" }),
        ],
        ctx()
      ),
      "rust"
    );
    expect(filtered[0]!.rows.map((r) => r.run.runId)).toEqual(["exact"]);
  });

  it("drops a group left with no matching rows", () => {
    expect(filterPilotGroups(groups(), "zzzz")).toEqual([]);
  });

  it("keeps every row when the project name itself matches", () => {
    expect(filterPilotGroups(groups(), "daintree")[0]!.rows).toHaveLength(2);
  });

  it("keeps every row when the project name matches without being typed whole", () => {
    // The short-circuit has to survive on match quality, not on the query
    // happening to be a substring: "fs" is neither contiguous in "fleet
    // snapshot" nor present in any row's own fields, so these rows are here
    // only because their project matched.
    const filtered = filterPilotGroups(
      buildPilotGroups(
        [
          run({ runId: "a", agentState: "working", title: "billing" }),
          run({ runId: "b", agentState: "working", title: "docs pass" }),
        ],
        ctx({
          workspaces: new Map([["p1", { kind: "project", name: "fleet snapshot", emoji: "🌳" }]]),
        })
      ),
      "fs"
    );
    expect(filtered[0]!.rows).toHaveLength(2);
  });

  it("does not admit a whole project on a loose project-name match", () => {
    // A match on the group name short-circuits every row beneath it, so "ate"
    // scraped out of "daintree" would surface the project's entire run list.
    // These titles cannot match "ate" themselves, so the group name is the only
    // thing under test.
    const filtered = filterPilotGroups(
      buildPilotGroups(
        [
          run({ runId: "a", agentState: "working", title: "billing" }),
          run({ runId: "b", agentState: "working", title: "docs pass" }),
        ],
        ctx()
      ),
      "ate"
    );
    expect(filtered).toEqual([]);
  });

  it("matches on the worktree when nothing else on the row does", () => {
    const filtered = filterPilotGroups(
      buildPilotGroups([run({ runId: "a", agentState: "working", title: "billing" })], ctx()),
      "scratch"
    );
    expect(filtered[0]!.rows.map((r) => r.run.runId)).toEqual(["a"]);
  });

  it("matches on the agent when nothing else on the row does", () => {
    // The agent rides the row as an icon, so its name is only ever reachable
    // through the query.
    const filtered = filterPilotGroups(
      buildPilotGroups(
        [run({ runId: "a", agentState: "working", agentId: "codex", title: "billing" })],
        ctx()
      ),
      "codex"
    );
    expect(filtered[0]!.rows.map((r) => r.run.runId)).toEqual(["a"]);
  });

  it("recounts demands against the filtered rows", () => {
    const filtered = filterPilotGroups(
      buildPilotGroups(
        [
          run({ runId: "a", agentState: "waiting", title: "auth refactor" }),
          run({ runId: "b", agentState: "waiting", title: "docs pass" }),
        ],
        ctx()
      ),
      "auth"
    );
    expect(filtered[0]!.demandCount).toBe(1);
  });

  it("demotes the top band when the query filters the worst row out", () => {
    // An inherited band renders a header about a run that is no longer on
    // screen: the group would read "0 agents blocked" in danger red above a row
    // that is only working.
    const unfiltered = buildPilotGroups(
      [
        run({
          runId: "a",
          agentState: "waiting",
          waitingReason: "error",
          title: "auth refactor",
        }),
        run({ runId: "b", agentState: "working", title: "docs pass" }),
      ],
      ctx()
    );
    const [filtered] = filterPilotGroups(unfiltered, "docs");

    const severity = (band: FleetBand): number => FLEET_BANDS.indexOf(band);
    expect(filtered!.rows.map((r) => r.run.runId)).toEqual(["b"]);
    expect(severity(filtered!.topBand)).toBeGreaterThan(severity(unfiltered[0]!.topBand));
    // The band is whatever the worst surviving row is, never a remembered one.
    expect(filtered!.topBand).toBe(filtered!.rows[0]!.band);
  });
});

describe("countPilotBands", () => {
  /** One run in each band, spread over two projects. */
  const wholeFleet = () =>
    buildPilotGroups(
      [
        run({
          runId: "blocked",
          workspaceId: "p1",
          agentState: "waiting",
          waitingReason: "error",
          since: NOW,
        }),
        run({ runId: "needs", workspaceId: "p1", agentState: "waiting", since: NOW }),
        run({ runId: "review", workspaceId: "p1", agentState: "completed", since: NOW }),
        run({ runId: "running", workspaceId: "p2", agentState: "working", since: NOW }),
        run({
          runId: "done",
          workspaceId: "p2",
          agentState: "completed",
          since: NOW - 120_000,
        }),
        run({
          runId: "parked",
          workspaceId: "p2",
          agentState: "waiting",
          since: NOW,
          park: { parkedAt: NOW - 60_000 },
        }),
        run({ runId: "idle", workspaceId: "p2", agentState: "exited", since: NOW }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "one" }],
          // Acknowledged after `done` finished but before `review` did, so the
          // two completions land in different bands.
          ["p2", { kind: "project", name: "two", lastCompletionSeenAt: NOW - 60_000 }],
        ]),
      })
    );

  it("maps every band onto the segments", () => {
    const counts = countPilotBands(wholeFleet());

    expect(counts.all).toBe(7);
    // Blocked and needs-you are one demand; review is a hand-back, not a block.
    expect(counts["needs-you"]).toBe(2);
    expect(counts.working).toBe(1);
    expect(counts.finished).toBe(2);
    // Parked and exited live only under All: the run parked while waiting must
    // NOT surface through the Waiting segment — hiding from that segment is
    // the entire point of parking it.
    expect(counts["needs-you"] + counts.working + counts.finished).toBe(counts.all - 2);
  });

  it("leaves an exited run out of every segment but All", () => {
    // An exited terminal isn't working, isn't finished, and isn't asking for
    // anything — putting it in a bucket would make that bucket lie.
    const counts = countPilotBands(
      buildPilotGroups([run({ runId: "gone", agentState: "exited", since: NOW })], ctx())
    );

    expect(counts.all).toBe(1);
    expect(counts["needs-you"] + counts.working + counts.finished).toBe(0);
  });

  it("counts the population it was handed, so a query narrows the segments", () => {
    const built = buildPilotGroups(
      [
        run({ runId: "a", agentState: "waiting", title: "auth refactor", since: NOW }),
        run({ runId: "b", agentState: "waiting", title: "docs pass", since: NOW }),
      ],
      ctx()
    );

    expect(countPilotBands(built)["needs-you"]).toBe(2);
    expect(countPilotBands(filterPilotGroups(built, "auth"))["needs-you"]).toBe(1);
  });
});

describe("parked rows", () => {
  it("ages a parked row from the park, not the underlying agent state", () => {
    // A three-hour-old waiting run parked two minutes ago must read
    // "Parked · 2m" — the row is now about the decision, not the wait.
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "waiting",
          since: NOW - 3 * 3_600_000,
          park: { parkedAt: NOW - 120_000, note: "after the migration" },
        }),
      ],
      ctx()
    );
    const row = group!.rows[0]!;

    expect(row.statusLabel).toBe("Parked");
    expect(row.age).toBe("2m");
  });

  it("orders parked rows by park age, oldest shelf first", () => {
    // Within-band anti-starvation, on the timestamp the band is about: the
    // agent-state `since` here would sort them the other way round.
    const [group] = buildPilotGroups(
      [
        run({
          runId: "recent",
          agentState: "waiting",
          since: NOW - 3_600_000,
          park: { parkedAt: NOW - 60_000 },
        }),
        run({
          runId: "ancient",
          agentState: "waiting",
          since: NOW - 60_000,
          park: { parkedAt: NOW - 3_600_000 },
        }),
      ],
      ctx()
    );

    expect(group!.rows.map((r) => r.run.runId)).toEqual(["ancient", "recent"]);
  });

  it("contributes nothing to a group's demand count, whatever the state under it", () => {
    const [group] = buildPilotGroups(
      [
        run({
          runId: "a",
          agentState: "waiting",
          waitingReason: "error",
          since: NOW,
          park: { parkedAt: NOW },
        }),
        run({ runId: "b", agentState: "waiting", since: NOW }),
      ],
      ctx()
    );

    expect(group!.demandCount).toBe(1);
    // And it sorts below the live demand it would otherwise have been.
    expect(group!.rows.map((r) => r.run.runId)).toEqual(["b", "a"]);
  });

  it("is admitted by no state segment — hiding from Waiting is the point of parking", () => {
    const groups = buildPilotGroups(
      [run({ agentState: "waiting", since: NOW, park: { parkedAt: NOW } })],
      ctx()
    );

    for (const segment of ["needs-you", "working", "finished"] as const) {
      expect(filterPilotBands(groups, segment)).toEqual([]);
    }
    expect(filterPilotBands(groups, "all")[0]!.rows).toHaveLength(1);
  });

  it("gets a segment of its own that admits nothing else", () => {
    const groups = buildPilotGroups(
      [
        run({ runId: "shelved", agentState: "waiting", since: NOW, park: { parkedAt: NOW } }),
        run({ runId: "live", agentState: "waiting", since: NOW }),
      ],
      ctx()
    );

    const [parkedOnly] = filterPilotBands(groups, "parked");
    expect(parkedOnly!.rows.map((r) => r.run.runId)).toEqual(["shelved"]);
    expect(countPilotBands(groups).parked).toBe(1);
  });

  it("is findable by its note — the user's own words for the run", () => {
    const groups = buildPilotGroups(
      [
        run({
          runId: "shelved",
          agentState: "waiting",
          since: NOW,
          title: "auth refactor",
          park: { parkedAt: NOW, note: "resume after the migration lands" },
        }),
        run({ runId: "other", agentState: "waiting", since: NOW, title: "docs pass" }),
      ],
      ctx()
    );

    const [matched] = filterPilotGroups(groups, "migration");
    expect(matched!.rows.map((r) => r.run.runId)).toEqual(["shelved"]);
  });
});

describe("stalled runs", () => {
  it("carries the quiet duration only for a working run main flagged", () => {
    const [group] = buildPilotGroups(
      [
        run({
          runId: "stalled",
          agentState: "working",
          since: NOW - 3_600_000,
          quietSince: NOW - 12 * 60_000,
        }),
        run({ runId: "busy", agentState: "working", since: NOW - 3_600_000 }),
      ],
      ctx()
    );

    const byId = new Map(group!.rows.map((r) => [r.run.runId, r]));
    expect(byId.get("stalled")?.quietFor).toBe("12m");
    expect(byId.get("busy")?.quietFor).toBeNull();
  });

  it("drops the cue when the run is no longer in the running band", () => {
    // A stale quietSince arriving alongside a state change (one poll of skew)
    // must not paint a waiting or parked row as a stalled worker.
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "working",
          since: NOW,
          quietSince: NOW - 12 * 60_000,
          park: { parkedAt: NOW },
        }),
      ],
      ctx()
    );

    expect(group!.rows[0]!.quietFor).toBeNull();
  });
});

describe("bandFilterHasDemand", () => {
  const bands = (overrides: Partial<Record<FleetBand, number>> = {}) => ({
    ...emptyBandCounts(),
    ...overrides,
  });

  it("separates a Finished segment awaiting review from one already acknowledged", () => {
    // The whole reason this exists: both are "2 finished", and only one of them
    // is still asking to be looked at.
    expect(bandFilterHasDemand(bands({ review: 2 }), "finished")).toBe(true);
    expect(bandFilterHasDemand(bands({ done: 2 }), "finished")).toBe(false);
  });

  it("treats any populated Needs-you segment as a demand", () => {
    // Every band it admits is a demand, so membership alone settles it.
    expect(bandFilterHasDemand(bands({ blocked: 1 }), "needs-you")).toBe(true);
    expect(bandFilterHasDemand(bands({ "needs-you": 1 }), "needs-you")).toBe(true);
    expect(bandFilterHasDemand(bands(), "needs-you")).toBe(false);
  });

  it("never reports a demand for Working or All", () => {
    // Working holds none by definition; All is the null option and reporting a
    // demand for it would make the answer "the fleet holds anything at all".
    // The bar hues Working anyway, deliberately and around this function —
    // see `segmentIsHued` in `PilotFilterBar`.
    expect(bandFilterHasDemand(bands({ running: 5 }), "working")).toBe(false);
    expect(bandFilterHasDemand(bands({ blocked: 5 }), "all")).toBe(false);
  });
});

describe("state vocabulary", () => {
  it("calls a waiting run the same thing on the row as on the segment that filters to it", () => {
    // The segment and the row's status word are two surfaces naming one state.
    // They drifted once — "Needs you" here against the sidebar's "Waiting" —
    // and one state with two names is a vocabulary the user has to learn twice.
    const waiting = run({ agentState: "waiting", waitingReason: "question" });

    expect(bandLabel(bandForRun(waiting), waiting)).toBe(PILOT_BAND_FILTER_LABEL["needs-you"]);
  });
});

describe("filterPilotBands", () => {
  const mixed = () =>
    buildPilotGroups(
      [
        run({
          runId: "blocked",
          workspaceId: "p1",
          agentState: "waiting",
          waitingReason: "error",
          since: NOW,
        }),
        run({ runId: "working", workspaceId: "p1", agentState: "working", since: NOW }),
        run({ runId: "idle", workspaceId: "p2", agentState: "exited", since: NOW }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "one" }],
          ["p2", { kind: "project", name: "two" }],
        ]),
      })
    );

  it("returns every row untouched for All", () => {
    const all = filterPilotBands(mixed(), "all");
    expect(all.flatMap((g) => g.rows.map((r) => r.run.runId))).toEqual([
      "blocked",
      "working",
      "idle",
    ]);
  });

  it("drops a group the segment leaves empty", () => {
    const filtered = filterPilotBands(mixed(), "needs-you");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.rows.map((r) => r.run.runId)).toEqual(["blocked"]);
  });

  it("recounts the demand tally against the surviving rows", () => {
    const [group] = filterPilotBands(mixed(), "working");

    // "working" survives in a project whose blocked run the segment removed —
    // an inherited tally would report a demand no longer on screen.
    expect(group!.demandCount).toBe(0);
    expect(group!.topBand).toBe("running");
  });

  it("finds the worst surviving band by rank, not by whichever row is first", () => {
    // Rows reaching a filter have been through `frozenOrder`, which pins the
    // order captured when the dialog opened — so once a run changes state the
    // first row is no longer the worst one present. Reading the band off row
    // zero would put a header's summary and its pip cluster at odds with the
    // rows directly underneath.
    const [built] = buildPilotGroups(
      [
        run({ runId: "urgent", agentState: "waiting", waitingReason: "error", since: NOW }),
        run({ runId: "asking", agentState: "waiting", since: NOW }),
        run({ runId: "calm", agentState: "working", since: NOW }),
      ],
      ctx()
    );
    const frozen = { ...built!, rows: [...built!.rows].reverse() };

    const [narrowed] = filterPilotBands([frozen], "needs-you");

    // Both demand rows survive, in the pinned order that puts the milder one
    // first — the band still has to come back as the worse of the two.
    expect(narrowed!.rows.map((r) => r.run.runId)).toEqual(["asking", "urgent"]);
    expect(narrowed!.rows[0]!.band).toBe("needs-you");
    expect(narrowed!.topBand).toBe("blocked");
  });

  it("intersects with a query rather than replacing it", () => {
    const built = buildPilotGroups(
      [
        run({ runId: "a", agentState: "waiting", title: "auth refactor", since: NOW }),
        run({ runId: "b", agentState: "working", title: "auth rewrite", since: NOW }),
        run({ runId: "c", agentState: "waiting", title: "docs pass", since: NOW }),
      ],
      ctx()
    );

    const both = filterPilotBands(filterPilotGroups(built, "auth"), "needs-you");

    // Only the row satisfying BOTH constraints survives.
    expect(both.flatMap((g) => g.rows.map((r) => r.run.runId))).toEqual(["a"]);
  });
});

describe("summarizePilotGroups", () => {
  it("counts by band so the footer cannot overstate what is live", () => {
    const summary = summarizePilotGroups(
      buildPilotGroups(
        [
          run({ runId: "a", agentState: "working" }),
          run({ runId: "b", agentState: "exited" }),
          run({ runId: "c", agentState: "idle" }),
          run({ runId: "d", agentState: "waiting" }),
        ],
        ctx()
      )
    );

    expect(summary.total).toBe(4);
    expect(summary.bands.running).toBe(1);
    expect(summary.demand).toBe(1);
  });

  it("agrees with the per-group demand counts it summarises", () => {
    const built = buildPilotGroups(
      [
        run({ runId: "a", workspaceId: "p1", agentState: "waiting" }),
        run({ runId: "b", workspaceId: "p2", agentState: "waiting", waitingReason: "error" }),
        run({ runId: "c", workspaceId: "p2", agentState: "working" }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { kind: "project", name: "one" }],
          ["p2", { kind: "project", name: "two" }],
        ]),
      })
    );

    const perGroup = built.reduce((sum, g) => sum + g.demandCount, 0);
    expect(summarizePilotGroups(built).demand).toBe(perGroup);
  });
});

describe("hasWorktreeAxis", () => {
  it("is false for runs that all share one worktree", () => {
    // Regrouping these would produce a single section holding the rows the
    // project already had — a drill that costs a gesture and says nothing.
    expect(hasWorktreeAxis([{ worktreeId: "/repo/wt/a" }, { worktreeId: "/repo/wt/a" }])).toBe(
      false
    );
  });

  it("is false for runs that all lack a worktree", () => {
    // The shape a scratch workspace always has, and a project worked only in
    // its own root. Both fall back rather than opening a one-section list.
    expect(hasWorktreeAxis([{}, { worktreeId: undefined }])).toBe(false);
  });

  it("is false with nothing to group", () => {
    // What keeps an empty scoped list unreachable from the shortcut.
    expect(hasWorktreeAxis([])).toBe(false);
  });

  it("counts the absent worktree as a bucket of its own", () => {
    // A root-launched run beside a worktree one is exactly the split worth
    // seeing, so "one real worktree" is not the same as "no axis".
    expect(hasWorktreeAxis([{ worktreeId: "/repo/wt/a" }, {}])).toBe(true);
  });

  it("is true across two worktrees", () => {
    expect(hasWorktreeAxis([{ worktreeId: "/repo/wt/a" }, { worktreeId: "/repo/wt/b" }])).toBe(
      true
    );
  });

  describe("with the project's own worktree count", () => {
    it("is true where every agent shares one worktree but the project has several", () => {
      // The bug: a fleet row exists only for a terminal classified an agent, so
      // drillability tracked where agents happened to be sitting rather than
      // whether the project has an axis at all (#11957).
      expect(hasWorktreeAxis([{ worktreeId: "/repo/wt/a" }, { worktreeId: "/repo/wt/a" }], 3)).toBe(
        true
      );
    });

    it("is true for a lone agent in a project with two worktrees", () => {
      expect(hasWorktreeAxis([{ worktreeId: "/repo/wt/a" }], 2)).toBe(true);
    });

    it("is true with no runs at all once the project is known to have two", () => {
      // A scoped view of a project with no agents says "none here yet", which
      // answers the question asked. The whole fleet answers a different one.
      expect(hasWorktreeAxis([], 2)).toBe(true);
    });

    it("is false where the project has exactly one worktree", () => {
      // The root checkout is a first-class entry in that count, so one means a
      // project worked only in its own root.
      expect(hasWorktreeAxis([{ worktreeId: "/repo" }], 1)).toBe(false);
    });

    it("is false where the project has no worktrees to speak of", () => {
      expect(hasWorktreeAxis([], 0)).toBe(false);
    });

    it("never lets an absent or zero count veto an axis the runs proved", () => {
      // The count is `undefined` for a view whose store has not mounted and
      // zero for one that has not hydrated. Neither is evidence AGAINST an
      // axis, so neither may take one the runs already established.
      expect(
        hasWorktreeAxis([{ worktreeId: "/repo/wt/a" }, { worktreeId: "/repo/wt/b" }], undefined)
      ).toBe(true);
      expect(hasWorktreeAxis([{ worktreeId: "/repo/wt/a" }, { worktreeId: "/repo/wt/b" }], 0)).toBe(
        true
      );
    });
  });
});

describe("buildPilotWorktreeGroups", () => {
  /** One project's rows, cut on the worktree axis, named in rendered order. */
  function worktreeGroups(
    runs: FleetRunRow[],
    mainWorktreeId?: string | null
  ): ReturnType<typeof buildPilotWorktreeGroups> {
    const [project] = buildPilotGroups(runs, ctx());
    return buildPilotWorktreeGroups(project!, mainWorktreeId);
  }

  it("groups a project's runs by worktree and keeps every run", () => {
    const groups = worktreeGroups([
      run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" }),
      run({ runId: "b", worktreeId: "/repo/wt/beta", agentState: "working" }),
      run({ runId: "c", worktreeId: "/repo/wt/alpha", agentState: "working" }),
    ]);

    expect(groups.map((g) => g.name)).toEqual(["alpha", "beta"]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.run.runId)).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps runs with no worktree, in a bucket ahead of the named ones", () => {
    // Dropping them would hide a live agent because a field was absent. The
    // bucket leads because a live agent filed under no worktree at all is an
    // anomaly worth seeing — NOT because it holds the root, which carries an id
    // of its own and gets its own section (#11957).
    const groups = worktreeGroups([
      run({ runId: "wt", worktreeId: "/repo/wt/alpha", agentState: "working" }),
      run({ runId: "root", agentState: "working" }),
    ]);

    expect(groups.map((g) => g.rows.map((r) => r.run.runId))).toEqual([["root"], ["wt"]]);
    expect(groups[0]!.worktreeId).toBeNull();
  });

  it("keys on the worktree id, never on the directory the agent is sitting in", () => {
    // `cwd` moves the moment an agent runs `cd`, so two runs in one worktree
    // would split into two sections the user cannot account for.
    const groups = worktreeGroups([
      run({ runId: "a", worktreeId: "/repo/wt/alpha", cwd: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/alpha", cwd: "/repo/wt/alpha/src/deep" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => r.run.runId).sort()).toEqual(["a", "b"]);
  });

  it("orders sections independently of severity", () => {
    // #11678's rule, on the second axis: a blocked agent turns its own
    // header's chip on, it does not lift the section over its neighbours.
    const calm = worktreeGroups([
      run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" }),
      run({ runId: "z", worktreeId: "/repo/wt/zulu", agentState: "working" }),
    ]);
    const alarmed = worktreeGroups([
      run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" }),
      run({ runId: "z", worktreeId: "/repo/wt/zulu", agentState: "waiting", since: NOW - 60_000 }),
    ]);

    expect(alarmed.map((g) => g.name)).toEqual(calm.map((g) => g.name));
    expect(alarmed.find((g) => g.name === "zulu")!.demandCount).toBe(1);
  });

  it("keeps the project's row ranking inside each worktree", () => {
    // Bucketing preserves array order, so worst-band-first and the
    // anti-starvation tiebreak survive the regrouping rather than being redone.
    const [group] = worktreeGroups([
      run({ runId: "working", worktreeId: "/repo/wt/alpha", agentState: "working" }),
      run({
        runId: "waiting",
        worktreeId: "/repo/wt/alpha",
        agentState: "waiting",
        since: NOW - 60_000,
      }),
    ]);

    expect(group!.rows.map((r) => r.run.runId)).toEqual(["waiting", "working"]);
  });

  it("recomputes each section's demand from its own rows", () => {
    // Inheriting the project's counts would print "1 needs you" over a
    // worktree holding nothing but a working agent.
    const groups = worktreeGroups([
      run({
        runId: "blocked",
        worktreeId: "/repo/wt/alpha",
        agentState: "waiting",
        since: NOW - 60_000,
      }),
      run({ runId: "busy", worktreeId: "/repo/wt/beta", agentState: "working" }),
    ]);

    expect(groups.map((g) => [g.name, g.demandCount])).toEqual([
      ["alpha", 1],
      ["beta", 0],
    ]);
    expect(groups[1]!.topBand).toBe("running");
  });

  it("gives colliding basenames enough path to tell them apart", () => {
    // Two headers reading "feature-x" file their agents under a distinction
    // the user cannot see.
    const groups = worktreeGroups([
      run({ runId: "a", worktreeId: "/repos/one/feature-x" }),
      run({ runId: "b", worktreeId: "/repos/two/feature-x" }),
    ]);

    expect(groups.map((g) => g.name).sort()).toEqual(["one/feature-x", "two/feature-x"]);
  });

  it("charges only the colliding worktrees for the extra path", () => {
    const groups = worktreeGroups([
      run({ runId: "a", worktreeId: "/repos/one/feature-x" }),
      run({ runId: "b", worktreeId: "/repos/two/feature-x" }),
      run({ runId: "c", worktreeId: "/repos/one/solo" }),
    ]);

    expect(groups.find((g) => g.rows[0]!.run.runId === "c")!.name).toBe("solo");
  });

  it("reads Windows separators as separators", () => {
    const groups = worktreeGroups([
      run({ runId: "a", worktreeId: "C:\\repos\\one\\feature-x" }),
      run({ runId: "b", worktreeId: "C:\\repos\\two\\feature-x" }),
    ]);

    expect(groups.map((g) => g.name).sort()).toEqual(["one/feature-x", "two/feature-x"]);
  });

  it("keeps a worktree literally named 'none' out of the no-worktree bucket", () => {
    // Ids are what selection, the pointer's order hold and the DOM key on, so
    // two sections sharing one make the second behave as the first. The wire
    // type is a bare string: nothing stops a worktree id spelling the sentinel.
    const groups = worktreeGroups([
      run({ runId: "root" }),
      run({ runId: "named", worktreeId: "none" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.groupId)).size).toBe(2);
  });

  it("falls back to whole ids for two worktrees differing only in case", () => {
    // The disambiguator folds case to DETECT a collision, because that is how
    // the name reads — but it cannot then emit one label for two real
    // directories, so it runs out of path and says both in full.
    const groups = worktreeGroups([
      run({ runId: "a", worktreeId: "/repos/one/Feature" }),
      run({ runId: "b", worktreeId: "/repos/one/feature" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.groupId)).size).toBe(2);
    expect(groups.map((g) => g.name).sort()).toEqual(["/repos/one/Feature", "/repos/one/feature"]);
  });

  it("gives two worktrees distinct ids where a variable-width escape would not", () => {
    // The escape marker plus `2f` spells `/`, and equally spells U+0002 then a
    // literal `f`. Encoded to one id, these two worktrees would share a DOM id,
    // a React key and an order-hold entry — one section swallowing the other.
    const groups = worktreeGroups([
      run({ runId: "slash", worktreeId: "/" }),
      run({ runId: "pair", worktreeId: `${String.fromCharCode(2)}f` }),
    ]);

    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.groupId)).size).toBe(2);
  });

  it("survives worktree ids the wire type allows but the app never mints", () => {
    // A display path has no business rejecting data. Every one of these is
    // type-valid, and the failure to avoid is a thrown palette rather than an
    // ugly heading — `encodeURIComponent` alone throws on the lone surrogate.
    const hostile = [
      "",
      "   ",
      "/",
      "//",
      "\\",
      "/repos/one/feature-x/",
      "C:\\repos\\one\\feature-x",
      "/repos/one/f e a t u r e",
      "/repos/one/\uD800",
      `/repos/${"deep/".repeat(60)}leaf`,
    ];
    const runs = hostile.map((worktreeId, i) => run({ runId: `r${i}`, worktreeId }));

    const groups = worktreeGroups(runs);

    // Nothing dropped: a live agent must not vanish because a field was odd.
    expect(groups.flatMap((g) => g.rows)).toHaveLength(runs.length);
    // Separately addressable, or two sections share a DOM id and a React key.
    expect(new Set(groups.map((g) => g.groupId)).size).toBe(groups.length);
    // Nameable: a blank heading files its rows under nothing at all.
    expect(groups.every((g) => g.name.trim().length > 0)).toBe(true);
  });

  it("files an empty worktree id with the runs whose worktree is unknown", () => {
    // An empty id identifies no worktree, so a section of its own would be a
    // blank heading standing beside the one that already means "unknown".
    const groups = worktreeGroups([
      run({ runId: "blank", worktreeId: "" }),
      run({ runId: "root" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.worktreeId).toBeNull();
    expect(groups[0]!.rows.map((r) => r.run.runId).sort()).toEqual(["blank", "root"]);
  });

  it("agrees with the drill gate about an empty id", () => {
    // The gate and the grouping have to count buckets the same way, or the
    // chevron promises an axis the regrouping then declines to cut.
    expect(hasWorktreeAxis([{ worktreeId: "" }, {}])).toBe(false);
  });

  it("opens the same way twice for the same fleet", () => {
    // The comparator has to be a total order, or spatial memory never forms.
    const runs = [
      run({ runId: "a", worktreeId: "/repo/wt/beta" }),
      run({ runId: "b", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "c" }),
    ];

    expect(worktreeGroups(runs).map((g) => g.groupId)).toEqual(
      worktreeGroups([...runs].reverse()).map((g) => g.groupId)
    );
  });

  describe("with the main worktree named", () => {
    /** A root whose basename sorts last, so only the lead rule can move it. */
    const ZEBRA_ROOT = "/repo/zebra";

    it("leads with the root even where its name sorts last", () => {
      // The complaint in #11957: root work sorted alphabetically among branch
      // checkouts, first by luck in a project called `daintree` and buried in
      // one called `zebra`.
      const groups = worktreeGroups(
        [
          run({ runId: "root", worktreeId: ZEBRA_ROOT }),
          run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
          run({ runId: "b", worktreeId: "/repo/wt/beta" }),
        ],
        ZEBRA_ROOT
      );

      expect(groups.map((g) => g.worktreeId)).toEqual([
        ZEBRA_ROOT,
        "/repo/wt/alpha",
        "/repo/wt/beta",
      ]);
    });

    it("keeps the alphabetical order when the id resolves to nothing", () => {
      // The two mint sites can spell one directory differently, so a miss has
      // to cost nothing but the lead position.
      const runs = [
        run({ runId: "root", worktreeId: ZEBRA_ROOT }),
        run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      ];

      expect(worktreeGroups(runs, "/private/repo/zebra").map((g) => g.worktreeId)).toEqual(
        worktreeGroups(runs).map((g) => g.worktreeId)
      );
    });

    it("puts the root ahead of the runs filed under no worktree", () => {
      const groups = worktreeGroups(
        [
          run({ runId: "root", worktreeId: ZEBRA_ROOT }),
          run({ runId: "orphan" }),
          run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
        ],
        ZEBRA_ROOT
      );

      expect(groups.map((g) => g.worktreeId)).toEqual([ZEBRA_ROOT, null, "/repo/wt/alpha"]);
    });

    it("does not let a null or empty id claim the no-worktree bucket", () => {
      // `null` would otherwise equal every unbucketed group and promote a
      // section of orphans as though it were the project root.
      const runs = [
        run({ runId: "orphan" }),
        run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
        run({ runId: "root", worktreeId: ZEBRA_ROOT }),
      ];

      for (const absent of [null, undefined, ""]) {
        expect(worktreeGroups(runs, absent).map((g) => g.worktreeId)).toEqual([
          null,
          "/repo/wt/alpha",
          ZEBRA_ROOT,
        ]);
      }
    });

    it("stays a total order with the root named", () => {
      const runs = [
        run({ runId: "a", worktreeId: "/repo/wt/beta" }),
        run({ runId: "root", worktreeId: ZEBRA_ROOT }),
        run({ runId: "b", worktreeId: "/repo/wt/alpha" }),
        run({ runId: "c" }),
      ];

      expect(worktreeGroups(runs, ZEBRA_ROOT).map((g) => g.groupId)).toEqual(
        worktreeGroups([...runs].reverse(), ZEBRA_ROOT).map((g) => g.groupId)
      );
    });
  });
});

describe("narrowing on the worktree axis", () => {
  function worktreeGroups(runs: FleetRunRow[]) {
    const [project] = buildPilotGroups(runs, ctx());
    return buildPilotWorktreeGroups(project!);
  }

  const SPREAD = [
    run({
      runId: "blocked",
      worktreeId: "/repo/wt/alpha",
      title: "Fix auth",
      agentState: "waiting",
      since: NOW - 60_000,
    }),
    run({ runId: "busy", worktreeId: "/repo/wt/beta", title: "Run tests", agentState: "working" }),
    run({
      runId: "quiet",
      worktreeId: "/repo/wt/beta",
      title: "Nothing alike",
      agentState: "working",
    }),
  ];

  it("drops a worktree the query emptied", () => {
    const filtered = filterPilotGroups(worktreeGroups(SPREAD), "auth");

    expect(filtered.map((g) => g.name)).toEqual(["alpha"]);
  });

  it("admits a whole worktree on its own name", () => {
    // Typing a worktree name to see everything in it is the question this
    // surface exists for, and it is the same rule the project name already got.
    // Both of beta's rows have to survive — one of them matches nothing about
    // the query itself, which is the whole point of a group-level match.
    const filtered = filterPilotGroups(worktreeGroups(SPREAD), "beta");

    expect(filtered.map((g) => g.name)).toEqual(["beta"]);
    expect(filtered.flatMap((g) => g.rows.map((r) => r.run.runId)).sort()).toEqual([
      "busy",
      "quiet",
    ]);
  });

  it("still admits the scope on the project's name after the drill", () => {
    // A query naming the PROJECT is how the user found the project to drill
    // into. Once inside, the project heading is gone and its name matches no
    // worktree label — so without the parent alias the drill would empty the
    // very list it just opened.
    const filtered = filterPilotGroups(worktreeGroups(SPREAD), "daintree");

    expect(filtered.flatMap((g) => g.rows)).toHaveLength(SPREAD.length);
  });

  it("counts and summarises the scoped population only", () => {
    const groups = worktreeGroups(SPREAD);

    expect(countPilotBands(groups).all).toBe(SPREAD.length);
    expect(summarizePilotGroups(groups).demand).toBe(1);
  });

  it("recomputes a band-filtered worktree's own summary", () => {
    const filtered = filterPilotBands(worktreeGroups(SPREAD), "needs-you");

    expect(filtered.map((g) => g.name)).toEqual(["alpha"]);
    expect(filtered[0]!.demandCount).toBe(1);
  });
});
