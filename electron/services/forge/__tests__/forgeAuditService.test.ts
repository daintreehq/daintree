import { afterEach, describe, expect, it, vi } from "vitest";

// The singleton wires to the electron-store; mock it so the module loads
// without constructing a real store under a mocked electron.
const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {
    forgeAudit: { auditEnabled: true, auditMaxRecords: 500 },
  };
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import { auditForgeCall, forgeAuditService } from "../forgeAuditService.js";

afterEach(() => vi.restoreAllMocks());

describe("auditForgeCall transparency", () => {
  it("returns the provider value even when appendRecord throws", async () => {
    vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {
      throw new Error("store corrupt");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await auditForgeCall(
      { providerId: "p", methodName: "listIssues" },
      async () => ({ items: [1, 2] })
    );

    expect(result).toEqual({ items: [1, 2] });
    expect(errSpy).toHaveBeenCalled(); // audit failure logged, not surfaced
  });

  it("rethrows the original provider error, not an appendRecord error", async () => {
    vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {
      throw new Error("store corrupt");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      auditForgeCall({ providerId: "p", methodName: "getPR" }, async () => {
        throw new Error("rate limited");
      })
    ).rejects.toThrow("rate limited");
  });

  it("classifies the provider value through the classify callback", async () => {
    const appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});

    await auditForgeCall(
      { providerId: "p", methodName: "getIssue" },
      async () => null,
      (v) => (v === null ? "not-found" : "success")
    );

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ methodName: "getIssue", result: "not-found" })
    );
  });
});
