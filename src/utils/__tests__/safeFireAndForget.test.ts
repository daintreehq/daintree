// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/rendererGlobalErrorHandlers", () => ({
  reportRendererGlobalError: vi.fn(),
}));

import { reportRendererGlobalError } from "@/utils/rendererGlobalErrorHandlers";
import { safeFireAndForget } from "../safeFireAndForget";

const mockedReport = vi.mocked(reportRendererGlobalError);

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
  }
}

describe("safeFireAndForget", () => {
  beforeEach(() => {
    mockedReport.mockReset();
  });

  afterEach(() => {
    mockedReport.mockReset();
  });

  it("does not report when the promise resolves", async () => {
    safeFireAndForget(Promise.resolve("ok"));
    await flushMicrotasks();
    expect(mockedReport).not.toHaveBeenCalled();
  });

  it("routes Error rejections through reportRendererGlobalError", async () => {
    const original = new Error("ipc failed");
    safeFireAndForget(Promise.reject(original));
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(1);
    const [kind, error, metadata] = mockedReport.mock.calls[0]!;
    expect(kind).toBe("unhandledrejection");
    expect(error).toBe(original);
    expect(metadata.message).toBe("ipc failed");
  });

  it("normalizes string rejections to Error", async () => {
    safeFireAndForget(Promise.reject("string failure"));
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(1);
    const [, error] = mockedReport.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("string failure");
  });

  it("normalizes null rejections to Error", async () => {
    safeFireAndForget(Promise.reject(null));
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(1);
    const [, error] = mockedReport.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
  });

  it("forwards options.context as the metadata message", async () => {
    safeFireAndForget(Promise.reject(new Error("inner")), {
      context: "marking onboarding step",
    });
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(1);
    const [, , metadata] = mockedReport.mock.calls[0]!;
    expect(metadata.message).toBe("marking onboarding step");
  });

  it("stitches the call-site stack onto the rejection error", async () => {
    function originatingCallSite(): void {
      safeFireAndForget(Promise.reject(new Error("boom")));
    }
    originatingCallSite();
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(1);
    const [, error] = mockedReport.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    const stack = (error as Error).stack ?? "";
    expect(stack).toContain("Caused by:");
    expect(stack).toContain("originatingCallSite");
  });

  it("preserves the original rejection message inside the stitched stack", async () => {
    safeFireAndForget(Promise.reject(new Error("ipc failed")));
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(1);
    const [, error] = mockedReport.mock.calls[0]!;
    const stack = (error as Error).stack ?? "";
    expect(stack).toContain("ipc failed");
    expect(stack).toContain("Caused by:");
  });

  it("does not re-stitch when the same Error is reported twice", async () => {
    const shared = new Error("shared rejection");
    safeFireAndForget(Promise.reject(shared));
    await flushMicrotasks();
    safeFireAndForget(Promise.reject(shared));
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(2);
    const [, secondError] = mockedReport.mock.calls[1]!;
    const stack = (secondError as Error).stack ?? "";
    const causedByMatches = stack.match(/Caused by:/g) ?? [];
    expect(causedByMatches.length).toBe(1);
  });

  it("preserves separate call-site anchors for concurrent rejections", async () => {
    function siteA(): void {
      safeFireAndForget(Promise.reject(new Error("a")));
    }
    function siteB(): void {
      safeFireAndForget(Promise.reject(new Error("b")));
    }
    siteA();
    siteB();
    await flushMicrotasks();

    expect(mockedReport).toHaveBeenCalledTimes(2);
    const stacks = mockedReport.mock.calls.map((call) => (call[1] as Error).stack ?? "");
    const fromA = stacks.find((s) => s.includes("siteA"));
    const fromB = stacks.find((s) => s.includes("siteB"));
    expect(fromA).toBeDefined();
    expect(fromB).toBeDefined();
    expect(fromA).not.toBe(fromB);
  });
});
