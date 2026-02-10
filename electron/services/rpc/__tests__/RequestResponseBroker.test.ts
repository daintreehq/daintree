import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestResponseBroker } from "../RequestResponseBroker.js";

describe("RequestResponseBroker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates unique ids with optional suffix", () => {
    const broker = new RequestResponseBroker({ idPrefix: "rpc" });
    const a = broker.generateId();
    const b = broker.generateId("pty");

    expect(a).toMatch(/^rpc-\d+-\d+$/);
    expect(b).toMatch(/^rpc-\d+-\d+-pty$/);
    expect(a).not.toBe(b);
  });

  it("resolves registered requests", async () => {
    const broker = new RequestResponseBroker();
    const promise = broker.register<string>("req-1");

    expect(broker.has("req-1")).toBe(true);
    expect(broker.resolve("req-1", "ok")).toBe(true);
    await expect(promise).resolves.toBe("ok");
    expect(broker.size).toBe(0);
  });

  it("rejects registered requests", async () => {
    const broker = new RequestResponseBroker();
    const promise = broker.register<string>("req-1");
    const error = new Error("failed");

    expect(broker.reject("req-1", error)).toBe(true);
    await expect(promise).rejects.toThrow("failed");
    expect(broker.size).toBe(0);
  });

  it("times out requests and calls onTimeout", async () => {
    const onTimeout = vi.fn();
    const broker = new RequestResponseBroker({ defaultTimeoutMs: 10, onTimeout });
    const promise = broker.register("req-timeout");

    vi.advanceTimersByTime(11);
    await expect(promise).rejects.toThrow("Request timeout: req-timeout");
    expect(onTimeout).toHaveBeenCalledWith("req-timeout");
    expect(broker.size).toBe(0);
  });

  it("rejects previous request when duplicate requestId is registered", async () => {
    const broker = new RequestResponseBroker({ defaultTimeoutMs: 1000 });
    const first = broker.register<string>("dup");
    const second = broker.register<string>("dup");

    await expect(first).rejects.toThrow("Duplicate request ID: dup");
    expect(broker.size).toBe(1);

    broker.resolve("dup", "latest");
    await expect(second).resolves.toBe("latest");
    expect(broker.size).toBe(0);
  });

  it("does not orphan newer request when duplicate old timeout fires", async () => {
    const broker = new RequestResponseBroker({ defaultTimeoutMs: 100 });
    const first = broker.register<string>("dup");
    const second = broker.register<string>("dup");

    await expect(first).rejects.toThrow("Duplicate request ID: dup");
    vi.advanceTimersByTime(101);

    await expect(second).rejects.toThrow("Request timeout: dup");
    expect(broker.size).toBe(0);
  });

  it("still rejects timeout even if onTimeout callback throws", async () => {
    const broker = new RequestResponseBroker({
      defaultTimeoutMs: 10,
      onTimeout: () => {
        throw new Error("timeout handler exploded");
      },
    });

    const promise = broker.register("req-timeout");
    vi.advanceTimersByTime(11);

    await expect(promise).rejects.toThrow("Request timeout: req-timeout");
    expect(broker.size).toBe(0);
  });

  it("falls back to default timeout for non-finite/invalid timeout override", async () => {
    const broker = new RequestResponseBroker({ defaultTimeoutMs: 20 });
    const promise = broker.register("req-invalid-timeout", Number.NaN);

    vi.advanceTimersByTime(10);
    expect(broker.has("req-invalid-timeout")).toBe(true);

    vi.advanceTimersByTime(11);
    await expect(promise).rejects.toThrow("Request timeout: req-invalid-timeout");
  });

  it("clear(error) rejects all pending requests", async () => {
    const broker = new RequestResponseBroker();
    const p1 = broker.register("a");
    const p2 = broker.register("b");
    broker.clear(new Error("shutdown"));

    await expect(p1).rejects.toThrow("shutdown");
    await expect(p2).rejects.toThrow("shutdown");
    expect(broker.size).toBe(0);
  });

  it("dispose rejects pending requests with broker disposed error", async () => {
    const broker = new RequestResponseBroker();
    const p = broker.register("a");
    broker.dispose();

    await expect(p).rejects.toThrow("Broker disposed");
    expect(broker.size).toBe(0);
  });
});
