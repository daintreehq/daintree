// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionQuestionAttachment,
  DecisionQuestionImageResult,
} from "@shared/types/decisionsQuestion";

const getQuestionImage = vi.hoisted(() =>
  vi.fn<
    (
      terminalId: string,
      questionId: string,
      attachmentId: string,
      signal?: AbortSignal
    ) => Promise<DecisionQuestionImageResult>
  >()
);
vi.mock("@/clients/decisionsClient", () => ({ decisionsClient: { getQuestionImage } }));

import { QuestionImageLoader, imagesKey } from "../questionImageLoader";

function image(n: number): DecisionQuestionAttachment {
  return {
    attachmentId: `attach_000${n}`,
    role: "other",
    alt: null,
    mime: "image/png",
    size: 3,
    sha256: String(n).repeat(64),
  };
}

const IMAGES = [image(1), image(2), image(3), image(4)];

/** Reads held open until the test settles each one; the latest read of an image first. */
const pending = new Map<string, Array<(result: DecisionQuestionImageResult) => void>>();

function settle(
  n: number,
  result?: DecisionQuestionImageResult,
  which: "latest" | "oldest" = "latest"
) {
  const attachment = image(n);
  const reads = pending.get(attachment.attachmentId) ?? [];
  const resolve = which === "latest" ? reads.at(-1) : reads[0];
  resolve?.(
    result ?? {
      result: "read",
      image: {
        attachmentId: attachment.attachmentId,
        mime: "image/png",
        sha256: attachment.sha256,
        bytes: new Uint8Array([1, 2, 3]),
      },
    }
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let urls = 0;

beforeEach(() => {
  pending.clear();
  urls = 0;
  getQuestionImage.mockReset().mockImplementation(
    (_t, _q, attachmentId) =>
      new Promise((resolve) => {
        pending.set(attachmentId, [...(pending.get(attachmentId) ?? []), resolve]);
      })
  );
  Reflect.set(
    URL,
    "createObjectURL",
    vi.fn(() => `blob:${(urls += 1)}`)
  );
  Reflect.set(URL, "revokeObjectURL", vi.fn());
});

afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

function readIds(): string[] {
  return getQuestionImage.mock.calls.map(([, , attachmentId]) => attachmentId);
}

describe("QuestionImageLoader", () => {
  it("reads two images at a time, in the question's order", async () => {
    const loader = new QuestionImageLoader("t1", "qa", IMAGES);
    loader.start();
    expect(readIds()).toEqual(["attach_0001", "attach_0002"]);

    settle(1);
    await flush();

    expect(readIds()).toEqual(["attach_0001", "attach_0002", "attach_0003"]);
    expect(loader.getSnapshot()["attach_0001"]).toEqual({ status: "ready", url: "blob:1" });
    expect(loader.getSnapshot()["attach_0003"]).toEqual({ status: "loading" });
  });

  it("reads an opened image next, ahead of the ones still waiting", async () => {
    const loader = new QuestionImageLoader("t1", "qa", IMAGES);
    loader.start();
    loader.prioritize("attach_0004");

    settle(2);
    await flush();

    expect(readIds()).toEqual(["attach_0001", "attach_0002", "attach_0004"]);
  });

  it("drops every image and revokes its URL on stop, and drops a read that lands after", async () => {
    const loader = new QuestionImageLoader("t1", "qa", IMAGES.slice(0, 2));
    const seen = vi.fn();
    loader.subscribe(seen);
    loader.start();
    settle(1);
    await flush();

    loader.stop();
    settle(2);
    await flush();

    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:1");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(Object.values(loader.getSnapshot())).toEqual([
      { status: "loading" },
      { status: "loading" },
    ]);
    // Aborted, so an image read in parts asks for no more of them.
    expect(getQuestionImage.mock.calls[1]![3]!.aborted).toBe(true);
  });

  it("starts over after a stop, as a remount does, and drops the read from before it", async () => {
    const loader = new QuestionImageLoader("t1", "qa", IMAGES.slice(0, 1));
    const seen = vi.fn();
    loader.subscribe(seen);
    loader.start();
    loader.stop();
    loader.start();
    seen.mockClear();

    settle(1, undefined, "oldest");
    await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
    expect(loader.getSnapshot()["attach_0001"]).toEqual({ status: "loading" });

    settle(1);
    await flush();
    expect(readIds()).toEqual(["attach_0001", "attach_0001"]);
    expect(loader.getSnapshot()["attach_0001"]).toMatchObject({ status: "ready" });
  });

  it("fails an image that couldn't be drawn and lets its URL go, once it was ready", async () => {
    const loader = new QuestionImageLoader("t1", "qa", IMAGES.slice(0, 2));
    loader.start();
    loader.undecodable("attach_0001");
    expect(loader.getSnapshot()["attach_0001"]).toEqual({ status: "loading" });

    settle(1);
    await flush();
    loader.undecodable("attach_0001");

    expect(loader.getSnapshot()["attach_0001"]).toEqual({
      status: "failed",
      failure: "undecodable",
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:1");
    loader.stop();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("says why an image failed, never with the error, and reads it again on retry", async () => {
    const loader = new QuestionImageLoader("t1", "qa", IMAGES.slice(0, 2));
    loader.start();
    getQuestionImage.mockClear();
    settle(1, { result: "not-running" });
    await flush();
    expect(loader.getSnapshot()["attach_0001"]).toEqual({
      status: "failed",
      failure: "not-running",
    });

    loader.retry("attach_0001");
    expect(loader.getSnapshot()["attach_0001"]).toEqual({ status: "loading" });
    expect(readIds()).toEqual(["attach_0001"]);
  });

  it("calls a read that broke failed, and retries nothing that hasn't failed", async () => {
    getQuestionImage.mockReset().mockRejectedValueOnce(new Error("image bytes"));
    getQuestionImage.mockImplementation(() => new Promise(() => {}));
    const loader = new QuestionImageLoader("t1", "qa", IMAGES.slice(0, 2));
    loader.start();
    await flush();

    expect(loader.getSnapshot()["attach_0001"]).toEqual({ status: "failed", failure: "failed" });
    loader.retry("attach_0002");
    expect(getQuestionImage).toHaveBeenCalledTimes(2);
  });
});

describe("imagesKey", () => {
  it("changes when an image's digest does, and not when nothing it names does", () => {
    const key = imagesKey("t1", "qa", IMAGES);
    expect(
      imagesKey(
        "t1",
        "qa",
        IMAGES.map((a) => ({ ...a, alt: "changed" }))
      )
    ).toBe(key);
    expect(
      imagesKey("t1", "qa", [{ ...image(1), sha256: "f".repeat(64) }, ...IMAGES.slice(1)])
    ).not.toBe(key);
    expect(imagesKey("t2", "qa", IMAGES)).not.toBe(key);
  });
});
