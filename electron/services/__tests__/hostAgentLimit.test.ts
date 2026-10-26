import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { _resetRemoteServicesForTest, registerRemoteService } from "../../remote/runtime.js";
import { AppError } from "../../utils/errorTypes.js";
import { computeHostAgentLimit } from "../../../shared/utils/hostAgentLimit.js";

vi.mock("../../utils/machineName.js", () => ({
  machineDisplayName: vi.fn(() => "Studio"),
}));

const {
  _resetHostAgentLimitCacheForTest,
  assertHostAgentCapacity,
  isHostAgentLimitError,
  readHostAgentLimit,
} = await import("../hostAgentLimit.js");
const { machineDisplayName } = await import("../../utils/machineName.js");

function counter(count: number) {
  return { countLiveAgentTerminals: vi.fn((_excludeId?: string) => count) };
}

function hostModeOn(): void {
  registerRemoteService("hostServer", {} as never);
}

describe("host agent limit (#14704)", () => {
  const limit = computeHostAgentLimit(os.totalmem());

  beforeEach(() => {
    _resetRemoteServicesForTest();
    _resetHostAgentLimitCacheForTest();
    vi.mocked(machineDisplayName).mockClear();
  });

  afterEach(() => {
    _resetRemoteServicesForTest();
  });

  it("holds nothing while Host mode isn't serving, without counting or naming the host", () => {
    const terminals = counter(limit + 5);

    expect(readHostAgentLimit(terminals)).toBeNull();
    expect(() => assertHostAgentCapacity(terminals, "t1")).not.toThrow();
    expect(terminals.countLiveAgentTerminals).not.toHaveBeenCalled();
    expect(machineDisplayName).not.toHaveBeenCalled();
  });

  it("reads the host's count against the ceiling its own memory sets", () => {
    hostModeOn();
    const terminals = counter(3);

    expect(readHostAgentLimit(terminals, "t1")).toEqual({ host: "Studio", count: 3, limit });
    expect(terminals.countLiveAgentTerminals).toHaveBeenCalledWith("t1");
  });

  it("names the host once however many launches ask", () => {
    hostModeOn();
    readHostAgentLimit(counter(0));
    readHostAgentLimit(counter(1));

    expect(machineDisplayName).toHaveBeenCalledTimes(1);
  });

  it("admits a launch below the ceiling and refuses one at it, naming the host", () => {
    hostModeOn();
    expect(() => assertHostAgentCapacity(counter(limit - 1), "t1")).not.toThrow();

    let thrown: unknown;
    try {
      assertHostAgentCapacity(counter(limit), "t1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(isHostAgentLimitError(thrown)).toBe(true);
    const appError = thrown as AppError;
    expect(appError.code).toBe("HOST_AGENT_LIMIT_REACHED");
    expect(appError.userMessage).toContain("Studio");
    expect(appError.details).toEqual({
      code: "HOST_AGENT_LIMIT_REACHED",
      host: "Studio",
      count: limit,
      limit,
    });
  });

  it("tells its own refusal apart from other errors", () => {
    expect(isHostAgentLimitError(new Error("x"))).toBe(false);
    expect(isHostAgentLimitError(new AppError({ code: "VALIDATION", message: "x" }))).toBe(false);
  });
});
