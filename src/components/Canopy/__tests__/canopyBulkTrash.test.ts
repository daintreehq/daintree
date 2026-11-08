// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { AgentState } from "@shared/types/agent";
import { isolatedComposerScope, makeDraftKey } from "@/lib/draftKey";
import { ALL_HOSTS_ID } from "@/store/canopyStore";
import { allHostsKey } from "../canopyAllHosts";
import { bulkTrashHold, hasReplyDraft } from "../canopyBulkTrash";
import { hostRefusal, refusedOutcomes } from "../canopyHostSource";
import type { CanopyItem } from "../canopyModel";

function item(runId: string, agentState?: AgentState, workspaceId = "p1"): CanopyItem {
  return { runId, workspaceId, row: { run: { agentState } } } as unknown as CanopyItem;
}

describe("bulkTrashHold", () => {
  it("holds back a run seen working, or with typed text, or a reply drafted here", () => {
    expect(bulkTrashHold(item("a", "working"), "empty", false)).toBe("working");
    expect(bulkTrashHold(item("a", "directing"), undefined, false)).toBe("working");
    expect(bulkTrashHold(item("a", "waiting"), "typed", false)).toBe("typed");
    expect(bulkTrashHold(item("a", "idle"), "empty", true)).toBe("reply");
    // Working is said first: it is what the person would weigh first.
    expect(bulkTrashHold(item("a", "working"), "typed", true)).toBe("working");
  });

  it("never holds back for the agent's own suggestion, or for an input nobody could read", () => {
    expect(bulkTrashHold(item("a", "waiting"), "suggestion", false)).toBeNull();
    expect(bulkTrashHold(item("a", "completed"), "unknown", false)).toBeNull();
    expect(bulkTrashHold(item("a", "exited"), undefined, false)).toBeNull();
  });
});

describe("hasReplyDraft", () => {
  const own = "own-host";
  const drafts = (entries: Array<[string, string]>) => new Map(entries);

  it("finds a reply drafted on the window's own host, under either name the run was shown by", () => {
    const local = makeDraftKey("r1", isolatedComposerScope());
    const viaAllHosts = makeDraftKey(allHostsKey(own, "r1"), isolatedComposerScope());
    expect(hasReplyDraft(drafts([[local, "fix it"]]), item("r1"), null, own)).toBe(true);
    expect(hasReplyDraft(drafts([[viaAllHosts, "fix it"]]), item("r1"), null, own)).toBe(true);
    expect(
      hasReplyDraft(
        drafts([[local, "fix it"]]),
        item(allHostsKey(own, "r1"), undefined, allHostsKey(own, "p1")),
        ALL_HOSTS_ID,
        own
      )
    ).toBe(true);
  });

  it("finds another host's reply only under that host's scope", () => {
    const remote = makeDraftKey("r1", isolatedComposerScope("remote"));
    const shownAllHosts = item(allHostsKey("remote", "r1"), undefined, allHostsKey("remote", "p1"));
    expect(hasReplyDraft(drafts([[remote, "go on"]]), shownAllHosts, ALL_HOSTS_ID, own)).toBe(
      true
    );
    expect(hasReplyDraft(drafts([[remote, "go on"]]), item("r1"), "remote", own)).toBe(true);
    // The same id on the window's own host is another terminal.
    expect(hasReplyDraft(drafts([[remote, "go on"]]), item("r1"), null, own)).toBe(false);
  });

  it("counts only text, not whitespace left behind", () => {
    const local = makeDraftKey("r1", isolatedComposerScope());
    expect(hasReplyDraft(drafts([[local, "  \n "]]), item("r1"), null, own)).toBe(false);
  });
});

describe("hostRefusal", () => {
  it("says a host too old for bulk trash plainly, rather than the call's name", () => {
    const refused = new Error(
      "[AppError|VALIDATION] canopy:trash-batch can't be called on another host's Canopy"
    );
    expect(hostRefusal(refused)).toMatch(/too old to trash agents together/);
  });

  it("gives a host's own words for a refusal, and plain errors as they are", () => {
    const driven = new Error(
      `[AppError|DRIVEN_ELSEWHERE|${encodeURIComponent("This project is being driven from another screen.")}] project p1 is driven elsewhere`
    );
    expect(hostRefusal(driven)).toBe("This project is being driven from another screen.");
    expect(hostRefusal(new Error("offline"))).toBe("offline");
  });

  it("names every run of a refused host", () => {
    expect(
      refusedOutcomes(
        [
          { runId: "a", spawnedAt: 1 },
          { runId: "b", spawnedAt: 2 },
        ],
        new Error("offline")
      )
    ).toEqual([
      { runId: "a", error: "offline" },
      { runId: "b", error: "offline" },
    ]);
  });
});
