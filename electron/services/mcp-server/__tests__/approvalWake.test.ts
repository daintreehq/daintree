import { afterEach, describe, expect, it } from "vitest";
import { createApprovalWake, type ApprovalWakeDeps, type HelpLane } from "../approvalWake.js";
import { GrantCache } from "../grantCache.js";
import { LANE_WAKE_ID_PATTERN } from "../terminalNotify.js";
import type { McpTier } from "../shared.js";

const LANE: HelpLane = { helpSessionId: "help-1", terminalId: "term-1", projectId: "proj-1" };
const TOOL = { kind: "tool", toolId: "project.runCheck" } as const;

describe("createApprovalWake (#14995)", () => {
  const caches: GrantCache[] = [];
  afterEach(() => {
    for (const cache of caches.splice(0)) cache.dispose();
  });

  function setup() {
    const grantCache = new GrantCache({ sweepIntervalMs: 0 });
    caches.push(grantCache);
    const state: { tier: McpTier | null; lane: HelpLane | null } = { tier: "core", lane: LANE };
    const deps: ApprovalWakeDeps = {
      sessionStore: {
        getTier: () => state.tier,
        grantCache,
      } as unknown as ApprovalWakeDeps["sessionStore"],
      helpLaneFor: () => state.lane,
    };
    return { deps, grantCache, state };
  }

  it("is ready while the grant it announces stands", () => {
    const { deps, grantCache } = setup();
    grantCache.issueGrant("s-1", TOOL.toolId);
    const wake = createApprovalWake(deps, "s-1", LANE, TOOL);
    expect(wake.kind).toBe("approval");
    expect(wake.approval).toEqual(TOOL);
    expect(wake.recheck()).toEqual({ kind: "ready" });
  });

  it("goes once the user ends the grant before the line is typed", () => {
    const { deps, grantCache } = setup();
    grantCache.issueGrant("s-1", TOOL.toolId);
    const wake = createApprovalWake(deps, "s-1", LANE, TOOL);
    grantCache.revokeGrant("s-1", TOOL.toolId);
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "approval-ended" });
  });

  it("goes once the session does", () => {
    const { deps, grantCache, state } = setup();
    grantCache.issueGrant("s-1", TOOL.toolId);
    const wake = createApprovalWake(deps, "s-1", LANE, TOOL);
    state.tier = null;
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "session-gone" });
  });

  it("goes once the lane runs in another terminal or none", () => {
    const { deps, grantCache, state } = setup();
    grantCache.issueGrant("s-1", TOOL.toolId);
    const wake = createApprovalWake(deps, "s-1", LANE, TOOL);
    state.lane = { ...LANE, terminalId: "term-2" };
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
    state.lane = null;
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
  });

  it("goes once the session serves another help session in the same terminal", () => {
    const { deps, grantCache, state } = setup();
    grantCache.issueGrant("s-1", TOOL.toolId);
    const wake = createApprovalWake(deps, "s-1", LANE, TOOL);
    state.lane = { ...LANE, helpSessionId: "help-2" };
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
  });

  it("holds a raised tool set only while the session still has it", () => {
    const { deps, state } = setup();
    state.tier = "full";
    const wake = createApprovalWake(deps, "s-1", LANE, { kind: "tier", tier: "full" });
    expect(wake.recheck()).toEqual({ kind: "ready" });
    state.tier = "core";
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "approval-ended" });
  });

  it("keeps one id per session and tool, so a repeat approval joins the queued line", () => {
    const { deps } = setup();
    const TIER = { kind: "tier", tier: "full" } as const;
    const first = createApprovalWake(deps, "s-1", LANE, TOOL);
    const tier = createApprovalWake(deps, "s-1", LANE, TIER);
    const ids = [
      first,
      createApprovalWake(deps, "s-1", LANE, { kind: "tool", toolId: "github.listIssues" }),
      tier,
      // A replacement transport's approval must not join a line its
      // predecessor's recheck is about to drop (#13360).
      createApprovalWake(deps, "s-2", LANE, TOOL),
    ].map((wake) => wake.id);
    expect(createApprovalWake(deps, "s-1", LANE, TOOL).id).toBe(first.id);
    expect(createApprovalWake(deps, "s-1", LANE, TIER).id).toBe(tier.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(LANE_WAKE_ID_PATTERN);
  });
});
