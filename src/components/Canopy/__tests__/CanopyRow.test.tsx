// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { CanopyCard as CanopyCardData, CanopyCategory } from "@shared/types/ipc/canopy";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { buildCanopyInbox, type CanopyItem } from "../canopyModel";
import { CanopyRow } from "../CanopyRow";
import { CanopyPriorityGlyph, priorityTier } from "../CanopyPriority";

const NOW = 1_700_000_000_000;

function itemFor(
  kind: CanopyCategory,
  card: Partial<CanopyCardData> = {},
  run: Partial<FleetRunRow> = {}
): CanopyItem {
  const fleetRun: FleetRunRow = {
    runId: "run-1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/Users/dev/app",
    agentId: "claude",
    agentState: "waiting",
    title: "Fix flaky panel tests",
    since: NOW - 60_000,
    ...run,
  };
  const groups = buildPilotGroups([fleetRun], {
    workspaces: new Map([["p1", { kind: "project", name: "app", emoji: "🦊" }]]),
    currentWorkspaceId: null,
    nowMs: NOW,
  });
  const data: CanopyCardData = {
    runId: "run-1",
    spawnedAt: NOW - 3_600_000,
    revision: 1,
    category: kind,
    confidence: 0.95,
    attentionProbability: 0.9,
    attentionScore: 88,
    priority: 88,
    task: "Fix flaky panel tests",
    risk: "unknown",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    stage: "described",
    wordsCategory: kind,
    describing: false,
    headline: "Choose push to develop or open a PR",
    summary: "Tests pass locally.",
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: NOW,
    ...card,
  };
  return buildCanopyInbox(groups, new Map([["run-1", data]]))[0]!;
}

function renderRow(
  item: CanopyItem,
  props: { unread?: boolean; compact?: boolean; asideLabel?: string | null } = {}
) {
  return render(
    <CanopyRow
      item={item}
      domId="row"
      isSelected={false}
      unread={props.unread ?? false}
      compact={props.compact}
      asideLabel={props.asideLabel}
      nowMs={NOW}
      tabbable
      reserveDetail
      onSelect={() => {}}
      onClick={() => {}}
      onOpen={() => {}}
    />
  );
}

const option = (container: HTMLElement) => container.querySelector<HTMLElement>("[role=option]")!;

/** What a screen reader hears after the name: every element the row points its description at. */
function description(container: HTMLElement): string {
  return (option(container).getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => container.querySelector(`#${id}`)?.textContent ?? "")
    .join(" | ");
}

const leadingColumn = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[role=option] > span[aria-hidden]")!;

describe("CanopyRow", () => {
  describe("before the readers have written words", () => {
    const unread = {
      stage: "classified" as const,
      headline: null,
      summary: null,
      wordsCategory: null,
      attentionScore: null,
      describing: true,
    };

    it("opens on the agent's recap, its first sentence as the ask and the rest beneath", () => {
      const { container } = renderRow(
        itemFor("finished", {
          ...unread,
          glance: {
            recap:
              "You ran npm test five times. All five failed the same way. Next: fix the rounding.",
            said: "All 5 runs failed.",
            doing: null,
            action: null,
          },
        })
      );
      expect(container.querySelector("#row-ask")!.textContent).toBe("You ran npm test five times.");
      expect(container.querySelector("#row-detail")!.textContent).toBe(
        "All five failed the same way. Next: fix the rounding."
      );
      expect(container.querySelector(".canopy-reading")).toBeNull();
    });

    it("says the step a working agent is on, with what it said it would do", () => {
      const { container } = renderRow(
        itemFor(
          "working",
          {
            ...unread,
            glance: {
              recap: null,
              said: "I'll examine the rounding logic in src/units.ts.",
              doing: "Reading 1 file: src/units.ts",
              action: null,
            },
          },
          { agentState: "working" }
        )
      );
      expect(container.querySelector("#row-ask")!.textContent).toBe("Reading 1 file: src/units.ts");
      expect(container.querySelector("#row-detail")!.textContent).toBe(
        "I'll examine the rounding logic in src/units.ts."
      );
    });

    it("does not repeat a question the agent's report opens with", () => {
      const { container } = renderRow(
        itemFor("question", {
          ...unread,
          question: "Which date format should the entry use?",
          glance: {
            recap: null,
            said: "Which date format should the entry use? For example: ISO 8601.",
            doing: null,
            action: null,
          },
        })
      );
      expect(container.querySelector("#row-detail")!.textContent).toBe("For example: ISO 8601.");
    });

    it("shows a screen's words for a run no reader has carded yet", () => {
      const run: FleetRunRow = {
        runId: "run-2",
        workspaceId: "p1",
        spawnedAt: NOW - 1_000,
        cwd: "/Users/dev/app",
        agentId: "codex",
        agentState: "completed",
        title: "Codex",
        since: NOW - 30_000,
      };
      const groups = buildPilotGroups([run], {
        workspaces: new Map([["p1", { kind: "project", name: "app", emoji: "🦊" }]]),
        currentWorkspaceId: null,
        nowMs: NOW,
      });
      const item = buildCanopyInbox(
        groups,
        new Map(),
        undefined,
        new Map(),
        new Map(),
        NOW,
        new Map([
          [
            "run-2",
            {
              runId: "run-2",
              spawnedAt: NOW - 1_000,
              glance: {
                recap: null,
                said: "Committed as 43d0e48. Tests pass.",
                doing: null,
                action: null,
              },
            },
          ],
        ])
      )[0]!;
      const { container } = renderRow(item);
      expect(container.querySelector("#row-ask")!.textContent).toBe("Committed as 43d0e48.");
      expect(container.querySelector("#row-detail")!.textContent).toBe("Tests pass.");
    });

    it("says a turn was interrupted before a report written ahead of it", () => {
      const { container } = renderRow(
        itemFor("finished", {
          ...unread,
          statusLine: "Interrupted · What should Claude do instead?",
          glance: {
            recap: null,
            said: "I'll update the checkout tests.",
            doing: null,
            action: null,
          },
        })
      );
      expect(container.querySelector("#row-ask")!.textContent).toBe(
        "Interrupted · What should Claude do instead?"
      );
    });

    it("does not repeat a one-sentence recap as the detail", () => {
      const { container } = renderRow(
        itemFor("finished", {
          ...unread,
          glance: {
            recap: "Fixed the rounding bug.",
            said: "Fixed the rounding bug. Tests pass.",
            doing: null,
            action: null,
          },
        })
      );
      expect(container.querySelector("#row-ask")!.textContent).toBe("Fixed the rounding bug.");
      expect(container.querySelector("#row-detail")!.textContent).toBe("Tests pass.");
    });

    it("never shows an old screen's words once the run's state has moved", () => {
      const { container } = renderRow(
        itemFor(
          "approval",
          {
            ...unread,
            observedAt: NOW - 120_000,
            statusLine: "Would you like to run the following command?",
            glance: { recap: null, said: null, doing: null, action: "npm test" },
          },
          { agentState: "working", since: NOW - 10_000 }
        )
      );
      expect(container.querySelector("#row-ask")!.textContent).not.toContain("Would you like");
      expect(container.textContent).not.toContain("npm test");
    });

    it("shows the reading placeholder only when the screen gave nothing", () => {
      const { container } = renderRow(itemFor("finished", unread));
      expect(container.querySelector("#row-ask")!.textContent).toBe("Reading the screen…");
    });

    it("holds a summary still on its way as bones, and a written one as words", () => {
      const due = renderRow(itemFor("finished", unread));
      expect(due.container.querySelector("#row-detail [data-canopy-detail-due]")).not.toBeNull();
      due.unmount();
      const written = renderRow(
        itemFor("finished", { ...unread, headline: "Done", summary: "Shipped the fix." })
      );
      expect(written.container.querySelector("[data-canopy-detail-due]")).toBeNull();
    });
  });

  it("makes a long wait on the user stand out, and only a long one", () => {
    const waitedFor = (ms: number) =>
      renderRow(
        itemFor(
          "approval",
          {},
          { agentState: "waiting", waitingReason: "approval", since: NOW - ms }
        )
      );
    expect(waitedFor(6 * 60_000).container.querySelector("[data-overdue]")).not.toBeNull();
    expect(waitedFor(60_000).container.querySelector("[data-overdue]")).toBeNull();
  });

  it("numbers a dialog's choices on the row, as the keys that pick them", () => {
    const { container } = renderRow(
      itemFor(
        "approval",
        {
          options: ["Yes, proceed", "No, and tell Codex what to do differently"],
          action: "npm test",
        },
        { agentState: "waiting", waitingReason: "approval" }
      )
    );
    const keys = [...container.querySelectorAll("kbd")].map((kbd) => kbd.textContent);
    expect(keys).toEqual(["1", "2"]);
    expect(container.textContent).toContain("$ npm test");
    expect(description(container)).toContain("answer with 1 Yes, proceed");
  });

  it("shows how far through its task a run is, counted off its checklist, and says it aloud", () => {
    const { container } = renderRow(
      itemFor("approval", { progress: 75, steps: { done: 4, total: 6, current: "Run tests" } })
    );
    expect(container.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("75");
    expect(container.textContent).toContain("75%");
    expect(container.textContent).not.toContain("4/6");
    expect(description(container)).toContain("4 of 6 steps done");
  });

  it("puts what a stopped run reported after where it runs", () => {
    const { container } = renderRow(
      itemFor("finished", { tests: "passing", changes: "uncommitted" }, { cwd: "/w/fix-rounding" })
    );
    const meta = [...container.querySelectorAll("span")].find((el) =>
      el.textContent?.startsWith("🦊")
    )!;
    // Each separator is its own padded dot, so the text runs them together.
    expect(meta.textContent).toBe("🦊app·fix-rounding·Tests pass·Not committed");
    // Every fact is a whole segment: one that doesn't fit drops, never "Tests p…".
    const facts = [...container.querySelectorAll("span")].filter(
      (el) => el.textContent === "·Tests pass" || el.textContent === "·Not committed"
    );
    expect(facts).toHaveLength(2);
    expect(description(container)).toContain("tests pass, not committed");
  });

  it("rings a waiting agent that is asking a question with a question mark", () => {
    const { container } = renderRow(itemFor("question"));
    expect(container.querySelector("[data-asking]")).not.toBeNull();
    expect(description(container)).toContain("asking you a question");
  });

  it("names a row by its agent alone, and says what it wants and where it is after that", () => {
    const { container } = renderRow(itemFor("question"), { unread: true });
    const name = option(container).getAttribute("aria-label")!;
    const heard = description(container);
    for (const part of ["Choose push to develop or open a PR", "Tests pass locally.", "app"]) {
      expect(name).not.toContain(part);
      expect(heard).toContain(part);
    }
    expect(name).not.toMatch(/priority|unread|waiting/i);
    expect(heard).toMatch(/unread/);
    expect(heard).toMatch(/priority 88/);
    // What it wants comes before the state and the place.
    expect(heard.indexOf("Choose push")).toBeLessThan(heard.indexOf("priority"));
  });

  it("reads out how long ago a run was replied to, as the row shows it", () => {
    const { container } = renderRow(itemFor("finished", { handledAt: NOW - 180_000 }), {
      compact: true,
      asideLabel: "Replied 3m ago",
    });
    expect(container.textContent).toContain("Replied 3m ago");
    expect(description(container)).toContain("replied 3m ago");
  });

  it("keeps what a run wants in the same ink once it has been read", () => {
    const ask = (unread: boolean) => {
      const { container, unmount } = renderRow(itemFor("question"), { unread });
      const ink = container.querySelector("[id='row-ask'] > span")!.className;
      unmount();
      return ink;
    };
    expect(ask(false)).toBe(ask(true));
  });

  it("never pulses words: only empty bones may", () => {
    const { container } = renderRow(
      itemFor("approval", { describing: true, headline: null, summary: null, stage: "classified" })
    );
    expect(container.textContent).toContain("Reading the screen…");
    for (const pulsing of container.querySelectorAll("[class*='animate-pulse']")) {
      expect(pulsing.textContent?.trim()).toBe("");
    }
  });

  it("shows an unlit meter and no number when no reading stands behind a priority", () => {
    const { container } = renderRow(
      itemFor("question", { stage: "classified", priorityFromEarlierRead: true })
    );
    const column = leadingColumn(container);
    expect(column.querySelectorAll("rect[opacity='1']")).toHaveLength(0);
    expect(column.querySelectorAll("rect")).toHaveLength(4);
    expect(column.textContent).not.toMatch(/\d{2}|—/);
  });

  it("keeps the plain waiting ring for a finished run, and for words from an earlier read", () => {
    expect(renderRow(itemFor("finished")).container.querySelector("[data-asking]")).toBeNull();
    expect(
      renderRow(itemFor("question", { wordsFromEarlierRead: true })).container.querySelector(
        "[data-asking]"
      )
    ).toBeNull();
  });

  it("drops the question mark once the screen moved and has not been read again", () => {
    const { container } = renderRow(
      itemFor("question", { stage: "classified", priorityFromEarlierRead: true })
    );
    expect(container.querySelector("[data-asking]")).toBeNull();
  });

  it("never puts the question mark over an observed blocked run", () => {
    const { container } = renderRow(itemFor("question", {}, { waitingReason: "error" }));
    expect(description(container)).toContain("blocked");
    expect(container.querySelector("[data-asking]")).toBeNull();
  });

  it("never claims a question for an agent Daintree sees working", () => {
    const { container } = renderRow(itemFor("question", {}, { agentState: "working" }));
    expect(container.querySelector("[data-asking]")).toBeNull();
  });

  it("shows a working agent's progress words, never the ask it has left, and keeps its summary", () => {
    const working = { agentState: "working" as const };
    const progress = renderRow(
      itemFor("working", { wordsCategory: "working", headline: "Editing the store" }, working)
    ).container;
    expect(progress.textContent).toContain("Editing the store");

    const leftBehind = renderRow(
      itemFor(
        "working",
        { wordsCategory: "approval", headline: "Approve the edit", activity: "Update(src/x.ts)" },
        working
      )
    ).container;
    expect(leftBehind.textContent).toContain("Update(src/x.ts)");
    expect(leftBehind.textContent).not.toContain("Approve the edit");
    // Its summary stays until the next reading replaces it.
    expect(leftBehind.textContent).toContain("Tests pass locally.");
  });

  it("says how long a working agent has gone unseen, and reads it out", () => {
    const { container } = renderRow(
      itemFor("working", { wordsCategory: "working" }, { agentState: "working" })
    );
    // Spawned an hour before NOW and never looked at since.
    expect(container.textContent).toContain("Unseen 1h");
    expect(description(container)).toContain("unseen 1h");
  });

  it("names the project by its emoji beside its name", () => {
    const { container } = renderRow(itemFor("finished"));
    expect(container.textContent).toContain("🦊");
    expect(container.textContent).toContain("app");
  });

  it("drops the emoji with the name when the row is titled after its project", () => {
    // A fresh session with no task yet and its cwd at the project root: the
    // title falls back to the project name, so the footer repeats neither.
    const { container } = renderRow(
      itemFor("idle", { task: null }, { title: "Claude", cwd: "/Users/dev/app" })
    );
    expect(container.textContent).toContain("app");
    expect(container.textContent).not.toContain("🦊");
  });

  it("says in words when a working agent has gone quiet, which the spinner shows only by hue", () => {
    const quiet = renderRow(
      itemFor("working", {}, { agentState: "working", quietSince: NOW - 14 * 60_000 }),
      { compact: true }
    ).container;
    expect(quiet.textContent).toContain("Quiet");
    const busy = renderRow(itemFor("working", {}, { agentState: "working" }), {
      compact: true,
    }).container;
    expect(busy.textContent).not.toContain("Quiet");
  });

  it("gives the leading column the time and the priority, never a word the glyph already says", () => {
    const { container } = renderRow(itemFor("question"));
    const column = leadingColumn(container);
    expect(column.textContent).toContain("1m");
    expect(column.textContent).toContain("88");
    expect(column.textContent).not.toMatch(/waiting|blocked/i);
    // The state still reaches a screen reader, with its time.
    expect(description(container)).toMatch(/waiting for 1m|blocked for 1m/);
  });
});

describe("CanopyPriorityGlyph", () => {
  it("fills one bar per step and draws the rest faint", () => {
    const filled = (priority: number) => {
      const { container } = render(<CanopyPriorityGlyph tier={priorityTier(priority)} />);
      const bars = [...container.querySelectorAll("rect")];
      expect(bars).toHaveLength(4);
      return bars.filter((bar) => bar.getAttribute("opacity") === "1").length;
    };
    expect(filled(95)).toBe(4);
    expect(filled(70)).toBe(3);
    expect(filled(50)).toBe(2);
    expect(filled(20)).toBe(1);
    expect(filled(0)).toBe(0);
  });
});
