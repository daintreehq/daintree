import { afterEach, describe, expect, it, vi } from "vitest";
import { onDevPreviewResume, resumeDevPreviews } from "../devPreviewResumeSignal";

describe("devPreviewResumeSignal", () => {
  const offs: Array<() => void> = [];
  afterEach(() => {
    while (offs.length > 0) offs.pop()!();
  });

  it("hands every listener the worktree and its panels", async () => {
    const listener = vi.fn();
    offs.push(onDevPreviewResume(listener));

    await resumeDevPreviews("wt-1", ["panel-1", "panel-2"]);

    expect(listener).toHaveBeenCalledTimes(1);
    const request = listener.mock.calls[0]![0];
    expect(request.worktreeId).toBe("wt-1");
    expect([...request.panelIds]).toEqual(["panel-1", "panel-2"]);
  });

  it("settles only after every listener's work has", async () => {
    let finish: () => void = () => {};
    offs.push(
      onDevPreviewResume(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      )
    );

    let settled = false;
    const done = resumeDevPreviews("wt-1", ["panel-1"]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await done;
    expect(settled).toBe(true);
  });

  it("waits for every listener's work, whichever settles last", async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const finishers: Array<() => void> = [];
      const listeners = [0, 1].map(() =>
        vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishers.push(resolve);
            })
        )
      );
      const offsForOrder = listeners.map((listener) => onDevPreviewResume(listener));

      let settled = false;
      const done = resumeDevPreviews("wt-1", ["panel-1"]).then(() => {
        settled = true;
      });
      expect(listeners[0]).toHaveBeenCalledTimes(1);
      expect(listeners[1]).toHaveBeenCalledTimes(1);

      finishers[order[0]!]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      finishers[order[1]!]!();
      await done;
      expect(settled).toBe(true);
      for (const off of offsForOrder) off();
    }
  });

  it("a rejecting listener doesn't settle it early while another is still working", async () => {
    let finish: () => void = () => {};
    offs.push(onDevPreviewResume(() => Promise.reject(new Error("async"))));
    offs.push(
      onDevPreviewResume(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      )
    );

    let settled = false;
    const done = resumeDevPreviews("wt-1", ["panel-1"]).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    finish();
    await done;
    expect(settled).toBe(true);
  });

  it("keeps going past a listener that throws or rejects, and never rejects itself", async () => {
    const before = vi.fn();
    const after = vi.fn();
    offs.push(onDevPreviewResume(before));
    offs.push(
      onDevPreviewResume(() => {
        throw new Error("sync");
      })
    );
    offs.push(onDevPreviewResume(() => Promise.reject(new Error("async"))));
    offs.push(onDevPreviewResume(after));

    await expect(resumeDevPreviews("wt-1", ["panel-1"])).resolves.toBeUndefined();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("reaches no listener once it has unsubscribed, and none at all for no panels", async () => {
    const listener = vi.fn();
    const off = onDevPreviewResume(listener);
    off();
    await resumeDevPreviews("wt-1", ["panel-1"]);

    offs.push(onDevPreviewResume(listener));
    await resumeDevPreviews("wt-1", []);

    expect(listener).not.toHaveBeenCalled();
  });
});
