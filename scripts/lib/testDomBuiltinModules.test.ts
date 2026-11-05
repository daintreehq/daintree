// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EventEmitter, getMaxListeners } from "node:events";
import fs from "node:fs";
import PQueue from "p-queue";

describe("DOM builtin module bridge", () => {
  it("runs the actual browser queue against JSDOM EventTarget", async () => {
    const queue = new PQueue({ concurrency: 1 });
    const completed: unknown[] = [];
    queue.addEventListener("completed", (event) => completed.push((event as CustomEvent).detail));

    await expect(queue.add(async () => "done")).resolves.toBe("done");
    await queue.onIdle();

    expect(completed).toEqual(["done"]);
  });

  it("retains native listener limits for Node emitters and leaves other builtins intact", () => {
    const emitter = new EventEmitter();
    const events = process.getBuiltinModule("node:events") as typeof import("node:events");

    events.setMaxListeners(7, emitter);

    expect(getMaxListeners(emitter)).toBe(7);
    expect(process.getBuiltinModule("node:fs")).toBe(fs);
  });
});
