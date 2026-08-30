import { describe, expect, it } from "vitest";
import {
  SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT,
  trimPreservingTask,
  type AgentSubagentMessage,
} from "../ipc/agentSubagents.js";

function reply(index: number): AgentSubagentMessage {
  return { role: "reply", text: `reply ${index}` };
}

const TASK: AgentSubagentMessage = { role: "task", text: "the delegated task" };

describe("trimPreservingTask", () => {
  it("leaves a transcript that already fits alone", () => {
    const messages = [TASK, reply(1)];
    trimPreservingTask(messages, 5);
    expect(messages).toEqual([TASK, reply(1)]);
  });

  it("drops the oldest replies and keeps the newest", () => {
    const messages = [TASK, reply(1), reply(2), reply(3)];
    trimPreservingTask(messages, 3);
    expect(messages).toEqual([TASK, reply(2), reply(3)]);
  });

  it("keeps the task even when it is not the oldest message", () => {
    // Every eviction shifts the array, so a protected position captured once
    // stops describing the task after the first splice.
    const messages = [reply(0), TASK, reply(1), reply(2), reply(3)];
    trimPreservingTask(messages, 2);
    expect(messages).toContainEqual(TASK);
    expect(messages).toHaveLength(2);
  });

  it("trims to exactly the limit whatever the task's position", () => {
    for (const taskAt of [0, 1, 5, 20]) {
      const messages: AgentSubagentMessage[] = Array.from({ length: 30 }, (_, i) => reply(i));
      messages.splice(taskAt, 0, TASK);
      trimPreservingTask(messages, SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT);
      expect(messages).toHaveLength(SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT);
      expect(messages).toContainEqual(TASK);
    }
  });

  it("still trims a transcript that never had a task in it", () => {
    const messages = [reply(1), reply(2), reply(3)];
    trimPreservingTask(messages, 2);
    expect(messages).toEqual([reply(2), reply(3)]);
  });

  it("lets the limit win when only the task is left to drop", () => {
    const messages = [TASK, reply(1)];
    trimPreservingTask(messages, 1);
    expect(messages).toEqual([TASK]);

    const empty = [TASK, reply(1)];
    trimPreservingTask(empty, 0);
    expect(empty).toEqual([]);
  });
});
