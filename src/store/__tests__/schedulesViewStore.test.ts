import { beforeEach, describe, expect, it } from "vitest";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { useSchedulesViewStore } from "../schedulesViewStore";

function answer(revision: number): SchedulesSnapshot {
  return {
    projectId: "p1",
    revision,
    switches: { schedulesOn: true, startWhenClosed: false, schedulesOnSince: 1 },
    schedules: [],
  };
}

beforeEach(() => useSchedulesViewStore.setState({ editorAnswer: null }));

describe("schedulesViewStore — the editor's answer", () => {
  it("is gone once the list has taken it", () => {
    const first = answer(2);
    useSchedulesViewStore.getState().answerEditor(first);
    expect(useSchedulesViewStore.getState().editorAnswer).toBe(first);
    useSchedulesViewStore.getState().takeEditorAnswer(first);
    expect(useSchedulesViewStore.getState().editorAnswer).toBeNull();
  });

  it("keeps a newer answer that arrived before the older one was taken", () => {
    // The same revision, so only the answer itself tells them apart.
    const first = answer(2);
    const second = answer(2);
    useSchedulesViewStore.getState().answerEditor(first);
    useSchedulesViewStore.getState().answerEditor(second);
    useSchedulesViewStore.getState().takeEditorAnswer(first);
    expect(useSchedulesViewStore.getState().editorAnswer).toBe(second);
  });
});
