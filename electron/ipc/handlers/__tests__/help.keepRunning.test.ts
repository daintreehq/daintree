import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";

const service = vi.hoisted(() => ({
  kept: new Set<string>(),
  saves: true,
  whenPendingHibernationStoreWired: vi.fn(async () => true),
  isLaneKeptRunning: vi.fn((projectId: string, slot: number) =>
    service.kept.has(`${projectId}:${slot}`)
  ),
  setLaneKeepRunning: vi.fn(async (projectId: string, slot: number, keep: boolean) => {
    if (keep) service.kept.add(`${projectId}:${slot}`);
    else service.kept.delete(`${projectId}:${slot}`);
    return service.saves;
  }),
  discardConversation: vi.fn(async () => {}),
}));
vi.mock("../../../services/HelpSessionService.js", () => ({ helpSessionService: service }));

const { handleDiscardConversation, handleGetKeepRunning, handleSetKeepRunning } =
  await import("../help.js");

const viewOf = (projectId: string | null): IpcContext => ({ projectId, webContentsId: 7 }) as never;

describe("keeping a lane running across restarts over IPC (#18177)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    service.kept.clear();
    service.saves = true;
    service.setLaneKeepRunning.mockClear();
    service.discardConversation.mockClear();
  });

  it("reads and sets a lane of the sender's own project, answering with the choice held", async () => {
    await expect(handleGetKeepRunning(viewOf("p1"), "p1", 2)).resolves.toBe(false);
    await expect(handleSetKeepRunning(viewOf("p1"), "p1", 2, true)).resolves.toBe(true);
    await expect(handleGetKeepRunning(viewOf("p1"), "p1", 2)).resolves.toBe(true);
    await expect(handleGetKeepRunning(viewOf("p1"), "p1", 0)).resolves.toBe(false);
  });

  it("refuses another project's lane, a lane that doesn't exist, and a choice that isn't one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    service.kept.add("p2:0");

    await expect(handleGetKeepRunning(viewOf("p1"), "p2", 0)).resolves.toBe(false);
    await expect(handleSetKeepRunning(viewOf("p1"), "p2", 0, false)).resolves.toBe(false);
    await expect(handleSetKeepRunning(viewOf("p1"), "p1", 99, true)).resolves.toBe(false);
    await expect(
      handleSetKeepRunning(viewOf("p1"), "p1", 0, "yes" as unknown as boolean)
    ).resolves.toBe(false);

    expect(service.setLaneKeepRunning).not.toHaveBeenCalled();
    expect(service.kept.has("p2:0")).toBe(true);
  });

  it("keeps the choice through a clear, and leaves the default to a Stop", async () => {
    await handleDiscardConversation(viewOf("p1"), "p1", 1, { keepRunningChoice: true });
    await handleDiscardConversation(viewOf("p1"), "p1", 1);
    await handleDiscardConversation(viewOf("p1"), "p1", 1, {
      keepRunningChoice: "yes" as unknown as boolean,
    });

    expect(service.discardConversation.mock.calls).toEqual([
      ["p1", 1, { keepRunningChoice: true }],
      ["p1", 1, undefined],
      ["p1", 1, undefined],
    ]);
  });
});
