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

  it("keeps going past a listener that throws or rejects, and never rejects itself", async () => {
    const after = vi.fn();
    offs.push(
      onDevPreviewResume(() => {
        throw new Error("sync");
      })
    );
    offs.push(onDevPreviewResume(() => Promise.reject(new Error("async"))));
    offs.push(onDevPreviewResume(after));

    await expect(resumeDevPreviews("wt-1", ["panel-1"])).resolves.toBeUndefined();
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
