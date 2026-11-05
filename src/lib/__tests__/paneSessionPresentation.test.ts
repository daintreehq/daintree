import { describe, it, expect } from "vitest";
import {
  isNeedsYouPane,
  isUnseenAskPane,
  resolvePaneSessionPresentation,
} from "../paneSessionPresentation";
import { FLEET_BANDS } from "../fleetAttention";

describe("resolvePaneSessionPresentation", () => {
  it("draws the waiting ring for needs-you and only needs-you", () => {
    for (const band of FLEET_BANDS) {
      const shown = resolvePaneSessionPresentation("waiting", band);
      expect(shown === "waiting", band).toBe(band === "needs-you");
    }
    expect(resolvePaneSessionPresentation("waiting", undefined)).toBeUndefined();
  });

  it("names each quiet wait by its band, and draws nothing for one that isn't news", () => {
    expect(resolvePaneSessionPresentation("waiting", "review")).toBe("unread");
    expect(resolvePaneSessionPresentation("waiting", "done")).toBe("completed");
    expect(resolvePaneSessionPresentation("waiting", "blocked", { waitingReason: "error" })).toBe(
      "blocked"
    );
    for (const band of ["idle", "parked", "snoozed", "running", "quiet"] as const) {
      expect(resolvePaneSessionPresentation("waiting", band), band).toBeUndefined();
    }
  });

  it("keeps work in flight as observed whatever the band says", () => {
    for (const state of ["working", "directing"] as const) {
      expect(resolvePaneSessionPresentation(state, "needs-you")).toBe(state);
      expect(resolvePaneSessionPresentation(state, "review")).toBe(state);
    }
    expect(resolvePaneSessionPresentation(undefined, "needs-you")).toBeUndefined();
  });

  it("never draws amber over an error wait the band hasn't caught up with", () => {
    expect(
      resolvePaneSessionPresentation("waiting", "needs-you", {
        agentState: "waiting",
        waitingReason: "error",
      })
    ).toBeUndefined();
  });
});

describe("isNeedsYouPane", () => {
  const asking = new Set(["t"]);

  it("holds a pane the band places in needs-you while it is still stopped", () => {
    for (const agentState of ["waiting", "completed", "idle", undefined] as const) {
      expect(isNeedsYouPane(asking, { id: "t", agentState }), String(agentState)).toBe(true);
    }
    expect(isNeedsYouPane(asking, { id: "u", agentState: "waiting" })).toBe(false);
  });

  it("drops it once the pane has seen the agent work, exit or hit an error", () => {
    for (const agentState of ["working", "directing", "exited"] as const) {
      expect(isNeedsYouPane(asking, { id: "t", agentState }), agentState).toBe(false);
    }
    expect(isNeedsYouPane(asking, { id: "t", agentState: "waiting", waitingReason: "error" })).toBe(
      false
    );
  });
});

describe("pane observation ahead of the band", () => {
  it("draws no amber through a restart or an exit the band hasn't caught up with", () => {
    for (const observed of [
      { isRestarting: true },
      // A terminal the host lost carries no exit code, only the status.
      { runtimeStatus: "exited" },
      { agentState: "exited" as const },
    ]) {
      expect(
        resolvePaneSessionPresentation("waiting", "needs-you", {
          agentState: "waiting",
          ...observed,
        }),
        JSON.stringify(observed)
      ).toBeUndefined();
      expect(isNeedsYouPane(new Set(["t"]), { id: "t", agentState: "waiting", ...observed })).toBe(
        false
      );
    }
    // What a successful restart can leave behind is no exit.
    expect(
      resolvePaneSessionPresentation("waiting", "needs-you", {
        agentState: "waiting",
        runtimeStatus: "error",
      })
    ).toBe("waiting");
  });
});

describe("isUnseenAskPane", () => {
  it("holds the agent's and Canopy's asks at any stop the pane is still at", () => {
    for (const ask of ["agent", "canopy"] as const) {
      for (const agentState of ["waiting", "completed", "idle", undefined] as const) {
        expect(isUnseenAskPane(ask, { agentState }), `${ask} ${agentState}`).toBe(true);
      }
      expect(isUnseenAskPane(ask, { agentState: "waiting", waitingReason: "prompt" })).toBe(true);
    }
    for (const agentState of ["waiting", "completed", "idle", undefined] as const) {
      expect(isUnseenAskPane(undefined, { agentState }), String(agentState)).toBe(false);
    }
  });

  it("holds an observed ask until the pane shows a different stop", () => {
    for (const waitingReason of ["approval", "question"] as const) {
      expect(isUnseenAskPane("observed", { agentState: "waiting", waitingReason })).toBe(true);
    }
    // A wait the pane holds no reason for (a directing spell drops it), or no
    // observation at all, is still the fleet's to call.
    expect(isUnseenAskPane("observed", { agentState: "waiting" })).toBe(true);
    expect(isUnseenAskPane("observed", {})).toBe(true);
    for (const pane of [
      { agentState: "waiting", waitingReason: "prompt" },
      { agentState: "completed" },
      { agentState: "idle" },
    ] as const) {
      expect(isUnseenAskPane("observed", pane), JSON.stringify(pane)).toBe(false);
      expect(isUnseenAskPane("canopy", pane), JSON.stringify(pane)).toBe(true);
      expect(isUnseenAskPane("agent", pane), JSON.stringify(pane)).toBe(true);
    }
  });

  it("drops any of them once the pane has seen the agent work, exit, restart or hit an error", () => {
    for (const ask of ["agent", "canopy", "observed"] as const) {
      for (const agentState of ["working", "directing", "exited"] as const) {
        expect(isUnseenAskPane(ask, { agentState }), `${ask} ${agentState}`).toBe(false);
      }
      const asking = { agentState: "waiting", waitingReason: "question" } as const;
      expect(isUnseenAskPane(ask, { agentState: "waiting", waitingReason: "error" })).toBe(false);
      expect(isUnseenAskPane(ask, { ...asking, isRestarting: true })).toBe(false);
      expect(isUnseenAskPane(ask, { ...asking, runtimeStatus: "exited" })).toBe(false);
    }
  });
});
