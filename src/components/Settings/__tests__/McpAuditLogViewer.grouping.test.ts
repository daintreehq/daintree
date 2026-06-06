import { describe, expect, it } from "vitest";
import { groupRecordsByTurn } from "../McpAuditLogViewer";
import type {
  AssistantTurnRecord,
  McpAuditRecord,
  McpGrantRecord,
  McpLogRecord,
} from "@shared/types";

function makeTurn(turnId: string, ts: number): AssistantTurnRecord {
  return {
    id: `turn-${turnId}`,
    timestamp: ts,
    terminalId: "term-1",
    sessionId: "help-1",
    outcome: "answered",
    turnId,
  };
}

function makeAudit(overrides: Partial<McpAuditRecord>): McpAuditRecord {
  return {
    id: overrides.id ?? "audit",
    timestamp: overrides.timestamp ?? 0,
    toolId: overrides.toolId ?? "t",
    sessionId: overrides.sessionId ?? "s",
    tier: overrides.tier ?? "action",
    argsSummary: overrides.argsSummary ?? "{}",
    result: overrides.result ?? "success",
    durationMs: overrides.durationMs ?? 0,
    schemaVersion: 1,
    severity: "info",
    ...overrides,
  };
}

function makeGrant(overrides: Partial<McpGrantRecord>): McpGrantRecord {
  return {
    id: overrides.id ?? "grant",
    timestamp: overrides.timestamp ?? 0,
    type: overrides.type ?? "grant.issued",
    sessionId: overrides.sessionId ?? "s",
    toolId: overrides.toolId ?? "t",
    ttlMs: overrides.ttlMs ?? 0,
    ...overrides,
  };
}

describe("groupRecordsByTurn — grant-lifecycle routing (#10027)", () => {
  it("places a pure orphan grant (no associated dispatch) into the trailing `lifecycle` section", () => {
    const grant = makeGrant({ id: "g1", sessionId: "sess-orphan", timestamp: 1 });
    const { groups, unassociated, lifecycle } = groupRecordsByTurn([grant], []);
    expect(groups).toHaveLength(0);
    expect(unassociated).toHaveLength(0);
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]!.id).toBe("g1");
  });

  it("rides a grant along with an unassociated dispatch that shares its `sessionId`", () => {
    const dispatch = makeAudit({ id: "a1", sessionId: "sess-mix" });
    const grant = makeGrant({ id: "g1", sessionId: "sess-mix" });
    const { groups, unassociated, lifecycle } = groupRecordsByTurn([dispatch, grant], []);
    expect(groups).toHaveLength(0);
    expect(lifecycle).toHaveLength(0);
    expect(unassociated).toHaveLength(2);
    expect(unassociated.map((r: McpLogRecord) => r.id).sort()).toEqual(["a1", "g1"]);
  });

  it("buckets a grant into the matching turn's `lifecycle` when the sessionId overlaps a turn", () => {
    const dispatch = makeAudit({
      id: "a1",
      sessionId: "sess-t1",
      turnId: "turn-1",
    });
    const grant = makeGrant({ id: "g1", sessionId: "sess-t1" });
    const turn = makeTurn("turn-1", 100);
    const { groups, unassociated, lifecycle } = groupRecordsByTurn([dispatch, grant], [turn]);
    expect(unassociated).toHaveLength(0);
    expect(lifecycle).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.lifecycle.map((r) => r.id)).toEqual(["g1"]);
  });

  it("keeps grants for unrelated sessions out of the matching turn's lifecycle", () => {
    const dispatch = makeAudit({ id: "a1", sessionId: "sess-t1", turnId: "turn-1" });
    const grant = makeGrant({ id: "g1", sessionId: "sess-orphan" });
    const turn = makeTurn("turn-1", 100);
    const { groups, unassociated, lifecycle } = groupRecordsByTurn([dispatch, grant], [turn]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.lifecycle).toHaveLength(0);
    expect(unassociated).toHaveLength(0);
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]!.id).toBe("g1");
  });
});
