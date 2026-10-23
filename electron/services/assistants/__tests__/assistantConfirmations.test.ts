import { describe, expect, it } from "vitest";
import { AGENT_DIRECTORY_CONFIRMATIONS_MAX } from "../../../../shared/types/agentDirectory.js";
import { AssistantConfirmations } from "../assistantConfirmations.js";

const wait = (actionId: string, since: number, expiresAt = since + 30_000) => ({
  actionId,
  since,
  expiresAt,
});

const A = { helpSessionId: "help-a", terminalId: "t-a" };
const B = { helpSessionId: "help-b", terminalId: "t-b" };
const OLD = { helpSessionId: "help-old", terminalId: "t-old" };

describe("AssistantConfirmations", () => {
  it("holds a waiting call from its start to its settle", () => {
    const confirmations = new AssistantConfirmations();
    confirmations.begin("call-1", A, wait("worktree.delete", 100));

    expect(confirmations.read(A, 200)).toEqual({
      waiting: [wait("worktree.delete", 100)],
      omitted: 0,
    });

    confirmations.settle("call-1");
    expect(confirmations.read(A, 200)).toEqual({ waiting: [], omitted: 0 });
  });

  it("keeps each session's waits to itself, so answering one lane leaves another's", () => {
    const confirmations = new AssistantConfirmations();
    confirmations.begin("call-a", A, wait("worktree.delete", 100));
    confirmations.begin("call-b", B, wait("terminal.closeAll", 150));

    confirmations.settle("call-a");

    expect(confirmations.read(A, 200).waiting).toEqual([]);
    expect(confirmations.read(B, 200).waiting).toEqual([wait("terminal.closeAll", 150)]);
  });

  it("never names a wait to the session that replaced its own", () => {
    const confirmations = new AssistantConfirmations();
    confirmations.begin("call-old", OLD, wait("worktree.delete", 100));

    expect(
      confirmations.read({ helpSessionId: "help-new", terminalId: "t-old" }, 200).waiting
    ).toEqual([]);
  });

  it("never names a wait to its own session once relaunched onto another terminal", () => {
    const confirmations = new AssistantConfirmations();
    confirmations.begin("call-1", A, wait("worktree.delete", 100));

    expect(confirmations.read({ ...A, terminalId: "t-a2" }, 200).waiting).toEqual([]);
  });

  it("holds two calls that share a key to the millisecond until each settles", () => {
    const confirmations = new AssistantConfirmations();
    confirmations.begin("same", A, wait("worktree.delete", 100));
    confirmations.begin("same", A, wait("worktree.delete", 100));

    expect(confirmations.read(A, 200).waiting).toHaveLength(2);
    confirmations.settle("same");
    expect(confirmations.read(A, 200).waiting).toHaveLength(1);
    confirmations.settle("same");
    expect(confirmations.read(A, 200).waiting).toEqual([]);
  });

  it("drops a wait past its deadline even when its settle never came", () => {
    const confirmations = new AssistantConfirmations();
    confirmations.begin("call-1", A, wait("worktree.delete", 100, 1_000));

    expect(confirmations.read(A, 999).waiting).toHaveLength(1);
    expect(confirmations.read(A, 1_000).waiting).toEqual([]);
    // Gone, not hidden: a later read with an earlier clock doesn't bring it back.
    expect(confirmations.read(A, 500).waiting).toEqual([]);
  });

  it("reclaims a wait past its deadline when another begins, with no reader at all", () => {
    const confirmations = new AssistantConfirmations();
    confirmations.begin("lost", A, wait("worktree.delete", 100, 1_000));
    confirmations.begin("next", B, wait("terminal.closeAll", 2_000));

    // Read with a clock before the lost wait's deadline: it is already gone.
    expect(confirmations.read(A, 500).waiting).toEqual([]);
  });

  it("names the oldest waits up to the cap and counts the rest", () => {
    const confirmations = new AssistantConfirmations();
    const total = AGENT_DIRECTORY_CONFIRMATIONS_MAX + 2;
    for (let i = total; i > 0; i--) {
      confirmations.begin(`call-${i}`, A, wait(`action.${i}`, i));
    }

    const read = confirmations.read(A, 10);
    expect(read.waiting.map((entry) => entry.since)).toEqual(
      Array.from({ length: AGENT_DIRECTORY_CONFIRMATIONS_MAX }, (_, i) => i + 1)
    );
    expect(read.omitted).toBe(2);
  });
});
