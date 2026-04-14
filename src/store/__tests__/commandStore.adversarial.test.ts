// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commandsClientMock = vi.hoisted(() => ({
  list: vi.fn(),
  getBuilder: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/clients/commandsClient", () => ({ commandsClient: commandsClientMock }));

import { useCommandStore } from "../commandStore";
import type { CommandManifestEntry } from "@shared/types/commands";

function resetStore() {
  useCommandStore.setState({
    isPickerOpen: false,
    activeCommand: null,
    activeCommandId: null,
    builderSteps: null,
    builderContext: null,
    isLoadingBuilder: false,
    builderLoadError: null,
    isExecuting: false,
    executionError: null,
    commands: [],
    isLoadingCommands: false,
  });
}

const makeCommand = (id: string, hasBuilder = true): CommandManifestEntry =>
  ({
    id,
    name: id,
    title: id,
    description: "",
    hasBuilder,
  }) as unknown as CommandManifestEntry;

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

afterEach(() => {
  resetStore();
});

describe("commandStore adversarial", () => {
  it("openBuilder for command B does not get its state overwritten by a late resolution from A", async () => {
    let resolveA: (v: { steps: unknown[] }) => void = () => {};
    const builderA = new Promise<{ steps: unknown[] }>((resolve) => {
      resolveA = resolve;
    });
    const builderB = { steps: [{ kind: "B-step" }] };

    commandsClientMock.getBuilder.mockImplementationOnce(() => builderA);
    commandsClientMock.getBuilder.mockResolvedValueOnce(builderB);

    const cmdA = makeCommand("a");
    const cmdB = makeCommand("b");

    const pendingA = useCommandStore.getState().openBuilder(cmdA, {});
    const pendingB = useCommandStore.getState().openBuilder(cmdB, {});

    await pendingB;
    resolveA({ steps: [{ kind: "A-step" }] });
    await pendingA;

    const state = useCommandStore.getState();
    expect(state.activeCommandId).toBe("b");
    expect(state.builderSteps).toEqual([{ kind: "B-step" }]);
    expect(state.isLoadingBuilder).toBe(false);
  });

  it("closeBuilder during a pending openBuilder keeps the store closed when resolution lands", async () => {
    let resolve: (v: { steps: unknown[] }) => void = () => {};
    commandsClientMock.getBuilder.mockImplementation(
      () =>
        new Promise<{ steps: unknown[] }>((r) => {
          resolve = r;
        })
    );

    const pending = useCommandStore.getState().openBuilder(makeCommand("a"), {});
    useCommandStore.getState().closeBuilder();

    resolve({ steps: [{ kind: "x" }] });
    await pending;

    const state = useCommandStore.getState();
    expect(state.activeCommand).toBeNull();
    expect(state.activeCommandId).toBeNull();
    expect(state.builderSteps).toBeNull();
    expect(state.isLoadingBuilder).toBe(false);
  });

  it("executeCommand throw normalizes to EXECUTION_ERROR and resets isExecuting", async () => {
    commandsClientMock.execute.mockRejectedValueOnce(new Error("boom"));

    const result = await useCommandStore.getState().executeCommand("c1", {});

    expect(result).toEqual({
      success: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    });
    expect(useCommandStore.getState().isExecuting).toBe(false);
    expect(useCommandStore.getState().executionError).toBe("boom");
  });

  it("executeCommand non-Error throw still produces a stable error shape", async () => {
    commandsClientMock.execute.mockRejectedValueOnce("string failure");

    const result = await useCommandStore.getState().executeCommand("c1", {});

    expect(result.success).toBe(false);
    expect(useCommandStore.getState().isExecuting).toBe(false);
  });

  it("executeCommand returns the original failure result and stores the error message", async () => {
    commandsClientMock.execute.mockResolvedValue({
      success: false,
      error: { code: "DENIED", message: "no access" },
    });

    const result = await useCommandStore.getState().executeCommand("c1", {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.code).toBe("DENIED");
    }
    expect(useCommandStore.getState().executionError).toBe("no access");
  });

  it("loadCommands reentrancy guard blocks duplicate fetches while one is in flight", async () => {
    let resolveList: (v: unknown[]) => void = () => {};
    commandsClientMock.list.mockImplementation(
      () =>
        new Promise<unknown[]>((r) => {
          resolveList = r;
        })
    );

    const p1 = useCommandStore.getState().loadCommands();
    const p2 = useCommandStore.getState().loadCommands();

    expect(commandsClientMock.list).toHaveBeenCalledTimes(1);

    resolveList([]);
    await Promise.all([p1, p2]);
  });

  it("loadCommands failure is logged but does not throw to caller", async () => {
    commandsClientMock.list.mockRejectedValueOnce(new Error("network"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(useCommandStore.getState().loadCommands()).resolves.toBeUndefined();
    expect(useCommandStore.getState().isLoadingCommands).toBe(false);

    consoleSpy.mockRestore();
  });

  it("openBuilder for command without builder skips the client call and clears loading state", async () => {
    const cmd = makeCommand("no-builder", false);
    await useCommandStore.getState().openBuilder(cmd, {});

    expect(commandsClientMock.getBuilder).not.toHaveBeenCalled();
    expect(useCommandStore.getState().isLoadingBuilder).toBe(false);
    expect(useCommandStore.getState().activeCommandId).toBe("no-builder");
  });

  it("openBuilder builder client returns null → store records 'Failed to load' error", async () => {
    commandsClientMock.getBuilder.mockResolvedValueOnce(null);

    await useCommandStore.getState().openBuilder(makeCommand("a"), {});

    expect(useCommandStore.getState().builderLoadError).toBe(
      "Failed to load command configuration"
    );
  });
});
