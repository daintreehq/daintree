import { describe, it, expect } from "vitest";
import { isNeedsYouPane, resolvePaneSessionPresentation } from "../paneSessionPresentation";
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
      { runtimeStatus: "exited" },
      { runtimeStatus: "error" },
      { exitCode: 0 },
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
    expect(resolvePaneSessionPresentation("waiting", "needs-you", { exitCode: null })).toBe(
      "waiting"
    );
  });
});
