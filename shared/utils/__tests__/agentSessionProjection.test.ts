import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { AgentSessionCloseCauseSchema } from "../../types/agentSessionSchemas.js";
import type {
  AgentSessionCloseCause,
  AgentSessionRecord,
} from "../../types/ipc/agentSessionHistory.js";
import { pageAgentFacingSessions, toAgentFacingRecord } from "../agentSessionProjection.js";

const RECORD: AgentSessionRecord = {
  sessionId: "sess-1",
  agentId: "claude",
  worktreeId: "wt-1",
  title: null,
  projectId: "project-1",
  savedAt: 1,
};

/** A journal row as `normalizeRecords` admits it: only `sessionId` is ever checked. */
const degraded = (fields: Record<string, unknown>) =>
  ({ ...RECORD, ...fields }) as unknown as AgentSessionRecord;

describe("what ended a session, in the agent-facing record (#16341)", () => {
  it("advertises every cause the journal records", () => {
    expectTypeOf<
      z.infer<typeof AgentSessionCloseCauseSchema>
    >().toEqualTypeOf<AgentSessionCloseCause>();
  });

  it.each(AgentSessionCloseCauseSchema.options)("carries a close cause of `%s`", (closedBy) => {
    const { sessions } = pageAgentFacingSessions(
      [{ ...RECORD, closedBy, terminal: { id: "terminal-1", spawnedAt: 42 } }],
      0,
      20
    );

    expect(sessions[0]?.closedBy).toBe(closedBy);
    expect(sessions[0]?.terminal).toEqual({ id: "terminal-1", spawnedAt: 42 });
  });

  it("adds neither key to a record journaled before they were kept", () => {
    const projected = toAgentFacingRecord(RECORD);

    expect(projected).not.toHaveProperty("closedBy");
    expect(projected).not.toHaveProperty("terminal");
  });

  it("carries nothing else off the terminal or the trash", () => {
    const projected = toAgentFacingRecord(
      degraded({
        closedBy: "user",
        terminal: { id: "terminal-1", spawnedAt: 42, env: { TOKEN: "x" } },
        trash: { expiresAt: 2, closedAt: 1 },
      })
    );

    expect(projected.terminal).toEqual({ id: "terminal-1", spawnedAt: 42 });
    expect(projected).not.toHaveProperty("trash");
  });

  it.each([
    ["a cause only a newer build journals", { closedBy: "hibernate" }, "closedBy"],
    ["a null cause", { closedBy: null }, "closedBy"],
    ["a terminal with no spawn time", { terminal: { id: "terminal-1" } }, "terminal"],
    ["a null terminal", { terminal: null }, "terminal"],
  ])("keeps the session and drops the field for %s", (_name, fields, key) => {
    const { sessions, total } = pageAgentFacingSessions([degraded(fields)], 0, 20);

    expect(total).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toHaveProperty(key);
  });
});
