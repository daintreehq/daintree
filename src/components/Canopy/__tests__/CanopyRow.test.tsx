// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { CanopyCard as CanopyCardData, CanopyCategory } from "@shared/types/ipc/canopy";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { buildCanopyInbox, type CanopyItem } from "../canopyModel";
import { CanopyRow, itemDetail, readerAttribution } from "../CanopyRow";

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
    waitingReason: "question",
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

/** The item the last row was rendered with: what it leaves to the selected pane is read off it. */
let lastItem: CanopyItem | undefined;

function renderRow(
  item: CanopyItem,
  props: {
    unread?: boolean;
    compact?: boolean;
    asideLabel?: string | null;
    onSelect?: () => void;
    onArchive?: () => void;
  } = {}
) {
  lastItem = item;
  // The archive button's tooltip needs the provider the app root gives it.
  return render(
    <TooltipProvider delayDuration={0}>
      <CanopyRow
        item={item}
        domId="row"
        isSelected={false}
        unread={props.unread ?? false}
        compact={props.compact}
        asideLabel={props.asideLabel}
        nowMs={NOW}
        tabbable
        onSelect={props.onSelect ?? (() => {})}
        onClick={() => {}}
        onOpen={() => {}}
        onArchive={props.onArchive}
      />
    </TooltipProvider>
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
  container.querySelector<HTMLElement>("[data-canopy-lead]")!;

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
      expect(itemDetail(lastItem!).detail).toBe(
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
      expect(container.querySelector("#row-ask > span")!.textContent).toBe(
        "Reading 1 file: src/units.ts"
      );
      expect(itemDetail(lastItem!).detail).toBe("I'll examine the rounding logic in src/units.ts.");
    });

    it("does not repeat a question the agent's report opens with", () => {
      renderRow(
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
      expect(itemDetail(lastItem!).detail).toBe("For example: ISO 8601.");
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
        handBack: { stoppedAt: NOW - 30_000 },
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
      expect(itemDetail(lastItem!).detail).toBe("Tests pass.");
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
      expect(itemDetail(lastItem!).detail).toBe("Tests pass.");
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

    it("carries no summary lines or bones, whether the words are in or on their way", () => {
      for (const item of [
        itemFor("finished", unread),
        itemFor("finished", { ...unread, headline: "Done", summary: "Shipped the fix." }),
      ]) {
        const { container, unmount } = renderRow(item);
        expect(container.querySelector("[data-canopy-detail-due]")).toBeNull();
        expect(container.querySelector("[id$='-detail']")).toBeNull();
        unmount();
      }
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

  it("leaves a dialog's choices and command to the selected pane, but still reads them out", () => {
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
    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(option(container).querySelector("[data-canopy-lead] + span")!.textContent).not.toContain(
      "npm test"
    );
    expect(itemDetail(lastItem!).action).toBe("npm test");
    expect(description(container)).toContain("answer with 1 Yes, proceed");
  });

  it("keeps progress off the row, counted off the checklist and said aloud", () => {
    const { container } = renderRow(
      itemFor("approval", { progress: 75, steps: { done: 4, total: 6, current: "Run tests" } })
    );
    expect(container.querySelector("[role=progressbar]")).toBeNull();
    expect(itemDetail(lastItem!).progress?.value).toBe(75);
    expect(description(container)).toContain("4 of 6 steps done");
  });

  it("reads a risky approval's reason aloud though the row no longer prints it", () => {
    const { container } = renderRow(
      itemFor(
        "approval",
        {
          headline: "Run the migration",
          risk: "caution",
          riskReason: "Rewrites every saved profile",
        },
        { waitingReason: "approval" }
      )
    );
    expect(description(container)).toContain("Rewrites every saved profile");
    expect(option(container).querySelector("[data-canopy-lead] + span")!.textContent).not.toContain(
      "Rewrites every saved profile"
    );
    expect(container.querySelector(".text-status-warning")).not.toBeNull();
  });

  it("says a stalled working run's screen hasn't changed, on the status line", () => {
    const { container } = renderRow(
      itemFor("working", { stalledSince: NOW - 120_000 }, { agentState: "working" })
    );
    expect(container.querySelector("#row-ask")!.textContent).toContain("No change 2m");
  });

  it("is three lines tall: the name, what it wants, and where it runs", () => {
    const { container } = renderRow(
      itemFor(
        "finished",
        { tests: "passing", changes: "uncommitted", contextLeft: 10, summary: "Shipped the fix." },
        { title: "Claude", lastObservedTitle: "✳ Fix flaky panel tests", cwd: "/w/fix-rounding" }
      )
    );
    const lines = option(container).querySelector("[data-canopy-lead] + span")!.children;
    expect(lines).toHaveLength(3);
    expect(lines[2]!.hasAttribute("data-canopy-where")).toBe(true);
    expect(lines[0]!.textContent).toContain("Fix flaky panel tests");
    expect(container.querySelector("[data-canopy-age]")!.parentElement).toBe(lines[0]);
    expect(container.querySelector("[data-canopy-where]")!.textContent).toBe("🦊app·fix-rounding");
    const reported = itemDetail(lastItem!);
    expect(reported.facts).toEqual(["Tests pass", "Not committed"]);
    expect(container.textContent).not.toContain("Shipped the fix.");
    expect(description(container)).toContain("reported tests pass, not committed");
  });

  it("rings a waiting agent that is asking a question with a question mark", () => {
    const { container } = renderRow(itemFor("question"));
    expect(container.querySelector("[data-asking]")).not.toBeNull();
    expect(description(container)).toContain("asking you a question");
  });

  it("rings a question Daintree's own classifier saw only as a hand-back prompt (#13234)", () => {
    for (const handBack of [
      { stoppedAt: NOW - 60_000 },
      { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 },
    ]) {
      const { container, unmount } = renderRow(
        itemFor("question", {}, { waitingReason: "prompt", handBack })
      );
      expect(container.querySelector("[data-asking]")).not.toBeNull();
      unmount();
    }
  });

  it("never rings a prompt with no hand-back record: that agent is idle", () => {
    const { container } = renderRow(itemFor("question", {}, { waitingReason: "prompt" }));
    expect(container.querySelector("[data-asking]")).toBeNull();
  });

  it("names a row by its terminal's title, and says what it wants and where it is after that", () => {
    const { container } = renderRow(
      itemFor(
        "question",
        { task: "Something the reader picked" },
        { title: "Claude", lastObservedTitle: "✳ Fix flaky panel tests" }
      ),
      { unread: true }
    );
    const name = option(container).getAttribute("aria-label")!;
    // The terminal's own title, never the line the reader picked as the task.
    expect(name.startsWith("Fix flaky panel tests")).toBe(true);
    expect(container.textContent).not.toContain("Something the reader picked");
    const heard = description(container);
    for (const part of ["Choose push to develop or open a PR", "app"]) {
      expect(name).not.toContain(part);
      expect(heard).toContain(part);
    }
    expect(name).not.toMatch(/priority|unread|waiting/i);
    expect(heard).toMatch(/unread/);
    // What it wants comes before the place.
    expect(heard.indexOf("Choose push")).toBeLessThan(heard.lastIndexOf("app"));
  });

  it("never says the title again under it, by the reading's words or the screen's own", () => {
    const titled = { title: "Claude", lastObservedTitle: "✳ Fix flaky panel tests" };
    const askLine = (container: HTMLElement) =>
      container.querySelector('[id$="-ask"]')?.textContent ?? "";
    const repeated = renderRow(
      itemFor(
        "finished",
        { headline: "Fix flaky panel tests.", statusLine: "Fix flaky panel tests" },
        titled
      )
    );
    expect(askLine(repeated.container)).toBe("Finished");
    repeated.unmount();
    // A summary that only repeats the title goes too.
    const summary = renderRow(
      itemFor(
        "finished",
        { headline: "All 14 tests pass.", summary: "Fix flaky panel tests" },
        titled
      )
    );
    expect(askLine(summary.container)).toBe("All 14 tests pass.");
    expect(summary.container.querySelector("[data-detail]")).toBeNull();
    summary.unmount();
    // Nor the screen's own words, before any reading has worded the run.
    const glance = renderRow(
      itemFor(
        "question",
        {
          stage: "classified",
          headline: null,
          summary: null,
          glance: { recap: null, said: "Fix flaky panel tests", doing: null, action: null },
        },
        titled
      )
    );
    expect(glance.container.textContent?.split("Fix flaky panel tests")).toHaveLength(2);
  });

  it("keeps an approval's caution and command when its headline only repeats the title", () => {
    const { container } = renderRow(
      itemFor(
        "approval",
        { headline: "Fix flaky panel tests", risk: "caution", action: "rm -rf dist" },
        { title: "Claude", lastObservedTitle: "✳ Fix flaky panel tests", waitingReason: "approval" }
      )
    );
    expect(itemDetail(lastItem!).action).toBe("rm -rf dist");
    expect(container.querySelector(".text-status-warning")).not.toBeNull();
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

  it("gives no score, on screen or read aloud: the order is the priority", () => {
    const { container } = renderRow(itemFor("question"));
    const shown = [...container.querySelectorAll("[aria-hidden='true']")]
      .map((element) => element.textContent)
      .join(" ");
    expect(shown).not.toContain("88");
    expect(container.querySelector("svg rect")).toBeNull();
    expect(description(container)).not.toMatch(/priority|88/);
  });

  it("marks an unread run by its title's weight, with no dot in the gutter", () => {
    const heavy = (unread: boolean) =>
      renderRow(itemFor("finished"), { unread }).container.querySelector(".font-semibold");
    expect(heavy(true)).not.toBeNull();
    expect(heavy(false)).toBeNull();
    expect(
      renderRow(itemFor("finished"), { unread: true }).container.querySelector(
        "[data-canopy-unread-dot]"
      )
    ).toBeNull();
  });

  it("says a finished run looks done as a reading, to a screen reader", () => {
    const { container } = renderRow(
      itemFor("finished", { tests: "passing", progress: 100 }, { agentState: "completed" })
    );
    expect(description(container)).toContain("looks done");
    expect(leadingColumn(container).textContent).not.toMatch(/done/i);
  });

  it("archives from the button under the pointer without selecting the row", () => {
    const onArchive = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderRow(itemFor("finished"), { onArchive, onSelect });
    const button = container.querySelector<HTMLButtonElement>("[data-canopy-row-archive]")!;
    // A mouse affordance: the keyboard has E, so it is neither tabbable nor announced.
    expect(button.tabIndex).toBe(-1);
    expect(button.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button);
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names the archive button on hover, with the key that does it", async () => {
    const { container, unmount } = renderRow(itemFor("finished"), { onArchive: vi.fn() });
    const button = () => container.querySelector<HTMLElement>("[data-canopy-row-archive]")!;
    fireEvent.pointerMove(button(), { pointerType: "mouse" });
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("Archive");
    expect(tip.textContent).toContain("E");
    unmount();

    const finished = itemFor("finished");
    const archived: CanopyItem = {
      ...finished,
      disposition: {
        runId: finished.runId,
        spawnedAt: 1,
        kind: "archived",
        at: NOW,
      },
    };
    const again = renderRow(archived, { onArchive: vi.fn() });
    fireEvent.pointerMove(
      again.container.querySelector<HTMLElement>("[data-canopy-row-archive]")!,
      { pointerType: "mouse" }
    );
    expect((await screen.findByRole("tooltip")).textContent).toContain("Move to inbox");
  });

  it("keeps the plain waiting ring for a finished run", () => {
    expect(renderRow(itemFor("finished")).container.querySelector("[data-asking]")).toBeNull();
  });

  it("keeps the question mark while new words for a question read just now are on their way", () => {
    // The classifier read this screen as asking; only the words are older.
    // Dropping the mark until they land made it blink off and on.
    expect(
      renderRow(itemFor("question", { wordsFromEarlierRead: true })).container.querySelector(
        "[data-asking]"
      )
    ).not.toBeNull();
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
    expect(itemDetail(lastItem!).detail).toBe("Tests pass locally.");
  });

  it("says how long a working agent has gone unseen, and reads it out", () => {
    const { container } = renderRow(
      itemFor("working", { wordsCategory: "working" }, { agentState: "working" })
    );
    // Spawned an hour before NOW and never looked at since.
    expect(container.textContent).toContain("Not checked 1h");
    expect(description(container)).toContain("not checked 1h");
  });

  it("names the project by its emoji beside its name", () => {
    const { container } = renderRow(itemFor("finished"));
    expect(container.textContent).toContain("🦊");
    expect(container.textContent).toContain("app");
  });

  it("keeps the project line on a row titled after its project", () => {
    // A fresh session with no task yet and its cwd at the project root: the
    // title falls back to the project name, and the footer still says where.
    const { container } = renderRow(
      itemFor("idle", { task: null }, { title: "Claude", cwd: "/Users/dev/app" })
    );
    const where = container.querySelector("[data-canopy-where]");
    expect(where?.textContent).toContain("🦊");
    expect(where?.textContent).toContain("app");
  });

  it("gives the host a slot of its own that stays whole beside long project and worktree names", () => {
    const item = itemFor("idle", {}, { cwd: "/Users/dev/app" });
    const long = {
      ...item,
      workspace: {
        ...item.workspace,
        name: "a-very-long-project-name-that-would-fill-the-line",
        host: "studio-01",
      },
      row: { ...item.row, worktreeLabel: "feature/a-very-long-branch-name-for-testing" },
    };
    const { container } = renderRow(long);
    const where = container.querySelector("[data-canopy-where]")!;
    expect(where.querySelector("[data-canopy-project]")?.textContent).toBe(long.workspace.name);
    expect(where.querySelector("[data-canopy-host]")?.textContent).toContain("studio-01");
    expect(where.querySelector("[data-canopy-host]")?.className).toContain("shrink-0");
    expect(where.textContent).not.toContain("studio-01 ·");
    // Location only: nothing else shares the line.
    expect(where.textContent).not.toContain("Quiet");
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

  it("gives the name line the time, never a score or a word the glyph already says", () => {
    const { container } = renderRow(
      itemFor(
        "question",
        {},
        {
          waitingReason: "question",
          canopy: { kind: "asked", quote: "Which branch?", readAt: NOW, seen: false },
        }
      )
    );
    const column = leadingColumn(container);
    expect(container.querySelector("[data-canopy-age]")!.textContent).toContain("1m");
    expect(column.textContent).not.toContain("88");
    expect(column.textContent).not.toMatch(/waiting|blocked/i);
    // The state still reaches a screen reader, with its time.
    expect(description(container)).toMatch(/waiting for 1m|blocked for 1m/);
  });

  describe("attribution of the reader's words", () => {
    const attribution = (container: HTMLElement) =>
      container.querySelector("[data-canopy-attribution]")?.textContent ?? null;

    it("tags no fresh read beside the ask, and says how long ago to a screen reader", () => {
      const { container } = renderRow(
        itemFor("question", { observedAt: NOW - 2 * 60_000 }, { since: NOW - 3 * 60_000 })
      );
      expect(attribution(container)).toBeNull();
      expect(description(container)).toContain("read 2m ago");
    });

    it("marks words kept from an earlier screen, and why they are still there", () => {
      const earlier = { wordsFromEarlierRead: true };
      expect(readerAttribution(itemFor("question", earlier), NOW)).toBe("Earlier screen");
      const failed = { ...itemFor("question", earlier), failed: true };
      expect(readerAttribution(failed, NOW)).toBe("Earlier screen, read failed");
      expect(attribution(renderRow(failed).container)).toBe("Earlier screen, read failed");
      const again = { ...itemFor("question", earlier), pending: true };
      expect(readerAttribution(again, NOW)).toBe("Earlier screen, reading again");
    });

    it("attributes nothing it did not read", () => {
      const { container } = renderRow(itemFor("question", { headline: null, stage: "classified" }));
      expect(attribution(container)).toBeNull();
    });

    it("flags the pane's summary as the reader's", () => {
      expect(itemDetail(itemFor("question")).readerWritten).toBe(true);
      expect(itemDetail(itemFor("question", { summary: null })).readerWritten).toBe(false);
    });
  });
});
