import { afterEach, describe, expect, it } from "vitest";
import { useProjectSleepConfirmStore, type SleepConfirmRequest } from "../projectSleepConfirmStore";

const request = (id: string): SleepConfirmRequest => ({
  kind: "project",
  projects: [
    {
      id,
      name: id,
      path: `/repos/${id}`,
      terminalCount: 0,
      waitingAgentCount: 0,
      activeAgentCount: 0,
      isActive: false,
    },
  ],
});

afterEach(() => useProjectSleepConfirmStore.getState().resolveConfirmation(false));

describe("projectSleepConfirmStore", () => {
  it("resolves the awaiting request with the answer and clears it", async () => {
    const store = useProjectSleepConfirmStore.getState();
    const answer = store.requestConfirmation(request("a"));
    expect(useProjectSleepConfirmStore.getState().pendingConfirm?.request.projects[0]!.id).toBe(
      "a"
    );
    store.resolveConfirmation(true);
    expect(await answer).toBe(true);
    expect(useProjectSleepConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("cancels a pending request when a newer one replaces it, and bumps the reset key", async () => {
    const store = useProjectSleepConfirmStore.getState();
    const seq = useProjectSleepConfirmStore.getState().requestSeq;
    const first = store.requestConfirmation(request("a"));
    const second = store.requestConfirmation(request("b"));
    expect(await first).toBe(false);
    expect(useProjectSleepConfirmStore.getState().requestSeq).toBe(seq + 2);
    useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    expect(await second).toBe(true);
  });

  it("ignores a resolve with nothing pending", () => {
    expect(() => useProjectSleepConfirmStore.getState().resolveConfirmation(true)).not.toThrow();
  });
});
