import { describe, expect, it, vi } from "vitest";
import { GlobalAssistantService } from "../GlobalAssistantService.js";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../agentDefaults.js", () => ({ onAgentDefaultsChanged: () => () => {} }));

const { fenceInputOnOwnerChange } = await import("../globalAssistant.js");

function makeService() {
  return new GlobalAssistantService({
    agentId: async () => "claude",
    provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "t", mcpUrl: null }),
    takeResume: async () => null,
    releaseResume: async () => {},
    discardResume: async () => {},
    spawn: async () => true,
    revoke: async () => {},
    kill: () => {},
    focusedWindows: () => [],
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("fenceInputOnOwnerChange (#14454)", () => {
  it("drops the run's pending PTY input each time input changes hands, and only then", async () => {
    const service = makeService();
    const cancelPendingInput = vi.fn();
    fenceInputOnOwnerChange(service, async () => ({ cancelPendingInput }));
    const { terminalId } = await service.ensureSession();
    await settle();
    expect(cancelPendingInput).not.toHaveBeenCalled();

    const a = service.attach(10, 1);
    const b = service.attach(20, 2);
    await settle();
    // A became the owner; B's attach moved nothing.
    expect(cancelPendingInput).toHaveBeenCalledTimes(1);

    service.claimInput(b, 20);
    await settle();
    expect(cancelPendingInput).toHaveBeenCalledTimes(2);
    expect(cancelPendingInput).toHaveBeenLastCalledWith(terminalId);

    service.claimInput(a, 10);
    await settle();
    expect(cancelPendingInput).toHaveBeenCalledTimes(3);
  });

  it("drops the departing owner's pending input once when main hands its input on (#16098)", async () => {
    const service = makeService();
    const cancelPendingInput = vi.fn();
    fenceInputOnOwnerChange(service, async () => ({ cancelPendingInput }));
    const { terminalId } = await service.ensureSession();
    const a = service.attach(10, 1);
    const b = service.attach(20, 2);
    await settle();
    cancelPendingInput.mockClear();

    service.detach(a, 10);
    await settle();
    expect(service.getState().inputOwner).toBe(b);
    expect(cancelPendingInput).toHaveBeenCalledTimes(1);
    expect(cancelPendingInput).toHaveBeenCalledWith(terminalId);
  });

  it("asks nothing of the PTY host while no run holds a terminal", async () => {
    const service = makeService();
    const cancelPendingInput = vi.fn();
    fenceInputOnOwnerChange(service, async () => ({ cancelPendingInput }));
    const a = service.attach(10, 1);
    service.releaseInput(a, 10);
    await settle();
    expect(cancelPendingInput).not.toHaveBeenCalled();
  });
});
