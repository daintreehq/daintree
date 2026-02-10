import { describe, expect, it, vi } from "vitest";
import {
  TerminalSerializerService,
  disposeTerminalSerializerService,
  getTerminalSerializerService,
} from "../TerminalSerializerService.js";

describe("TerminalSerializerService", () => {
  it("switches to async serialization at threshold", () => {
    const service = new TerminalSerializerService();
    expect(service.shouldUseAsync(999)).toBe(false);
    expect(service.shouldUseAsync(1000)).toBe(true);
    expect(service.shouldUseAsync(5000)).toBe(true);
    service.dispose();
  });

  it("deduplicates concurrent serialize requests per terminal", async () => {
    const service = new TerminalSerializerService();
    const serializeFn = vi.fn(() => "snapshot-data");

    const first = service.serializeAsync("term-1", serializeFn);
    const second = service.serializeAsync("term-1", serializeFn);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe("snapshot-data");
    expect(b).toBe("snapshot-data");
    expect(serializeFn).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("returns null on serializer failure and allows subsequent retry", async () => {
    const service = new TerminalSerializerService();
    const failing = vi.fn(() => {
      throw new Error("boom");
    });

    const failed = await service.serializeAsync("term-2", failing);
    expect(failed).toBeNull();

    const retryFn = vi.fn(() => "ok");
    const retried = await service.serializeAsync("term-2", retryFn);
    expect(retried).toBe("ok");
    expect(retryFn).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("cancels pending serialization after dispose", async () => {
    const service = new TerminalSerializerService();
    const serializeFn = vi.fn(() => "late-result");

    const pending = service.serializeAsync("term-3", serializeFn);
    service.dispose();

    const result = await pending;
    expect(result).toBeNull();
    expect(serializeFn).not.toHaveBeenCalled();
  });

  it("resets singleton instance on dispose helper", () => {
    const first = getTerminalSerializerService();
    disposeTerminalSerializerService();
    const second = getTerminalSerializerService();

    expect(second).not.toBe(first);
    disposeTerminalSerializerService();
  });
});
