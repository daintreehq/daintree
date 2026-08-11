import { beforeEach, describe, expect, it } from "vitest";
import { useCopyTreeRunStore } from "../copyTreeRunStore";

beforeEach(() => {
  useCopyTreeRunStore.setState({ activeRunCount: 0 });
});

describe("copyTreeRunStore", () => {
  it("keeps the count positive until every overlapping run has settled", () => {
    // The reason this is a count and not a boolean: an MCP copy landing while
    // a manual one is generating must not switch the spinner off early.
    const { beginRun, endRun } = useCopyTreeRunStore.getState();

    beginRun();
    beginRun();
    endRun();
    expect(useCopyTreeRunStore.getState().activeRunCount).toBe(1);

    endRun();
    expect(useCopyTreeRunStore.getState().activeRunCount).toBe(0);
  });

  it("clamps at zero so a double-settled run cannot eat the next run's spinner", () => {
    const { beginRun, endRun } = useCopyTreeRunStore.getState();

    endRun();
    expect(useCopyTreeRunStore.getState().activeRunCount).toBe(0);

    beginRun();
    expect(useCopyTreeRunStore.getState().activeRunCount).toBe(1);
  });
});
