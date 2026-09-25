import { afterEach, describe, expect, it, vi } from "vitest";
import { mintOperationId, operationsClient } from "../operationsClient";

const operations = {
  getStatus: vi.fn(async () => ({ status: "unknown" })),
  list: vi.fn(async () => []),
  cancel: vi.fn(async () => true),
  onEvent: vi.fn(() => () => {}),
};

vi.stubGlobal("window", { electron: { operations } });

afterEach(() => vi.clearAllMocks());

describe("operationsClient", () => {
  it("mints a distinct uuid per operation", () => {
    const a = mintOperationId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(mintOperationId()).not.toBe(a);
  });

  it("wraps ids into the namespace's payloads", async () => {
    await operationsClient.getStatus("op-1");
    await operationsClient.cancel("op-1");
    await operationsClient.list();
    await operationsClient.list("p1");

    expect(operations.getStatus).toHaveBeenCalledWith({ opId: "op-1" });
    expect(operations.cancel).toHaveBeenCalledWith({ opId: "op-1" });
    expect(operations.list).toHaveBeenNthCalledWith(1, {});
    expect(operations.list).toHaveBeenNthCalledWith(2, { projectId: "p1" });
  });
});
