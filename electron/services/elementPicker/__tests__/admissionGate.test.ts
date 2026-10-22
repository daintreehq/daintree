import { describe, expect, it } from "vitest";
import { AdmissionGate, MAX_CONCURRENT_RESOLVES, MAX_QUEUED_RESOLVES } from "../admissionGate.js";

const open = () => new AbortController().signal;

describe("AdmissionGate", () => {
  it("hands a released slot to the longest waiter", async () => {
    const gate = new AdmissionGate();
    const releases = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_RESOLVES }, () => gate.acquire(open()))
    );
    const order: string[] = [];
    const first = gate.acquire(open()).then((release) => (order.push("first"), release));
    const second = gate.acquire(open()).then((release) => (order.push("second"), release));
    await Promise.resolve();
    expect(order).toEqual([]);

    releases[0]!();
    // Idempotent: a second call must not free a second slot.
    releases[0]!();
    await first;
    expect(order).toEqual(["first"]);
    releases[1]!();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("refuses with HOST_BUSY once the queue is full", async () => {
    const gate = new AdmissionGate();
    await Promise.all(Array.from({ length: MAX_CONCURRENT_RESOLVES }, () => gate.acquire(open())));
    const controller = new AbortController();
    const queued = Array.from({ length: MAX_QUEUED_RESOLVES }, () =>
      gate.acquire(controller.signal).catch(() => "left")
    );
    await expect(gate.acquire(open())).rejects.toMatchObject({ code: "HOST_BUSY" });
    controller.abort();
    await expect(Promise.all(queued)).resolves.toEqual(Array(MAX_QUEUED_RESOLVES).fill("left"));
  });

  it("lets an aborted waiter leave the queue without taking a slot", async () => {
    const gate = new AdmissionGate();
    const releases = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_RESOLVES }, () => gate.acquire(open()))
    );
    const controller = new AbortController();
    const leaving = gate.acquire(controller.signal);
    const staying = gate.acquire(open());
    controller.abort();
    await expect(leaving).rejects.toBeDefined();
    releases[0]!();
    await expect(staying).resolves.toBeTypeOf("function");
  });
});
