import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBootstrapErrorGuard } from "../bootstrapErrorGuard.js";

type Handler = (arg: unknown) => void;

function install(postError: (message: string) => void = vi.fn()) {
  const handlers: Record<string, Handler> = {};
  const onSpy = vi.spyOn(process, "on").mockImplementation((event: string | symbol, handler) => {
    handlers[event as string] = handler as Handler;
    return process;
  });
  installBootstrapErrorGuard({ label: "[TestBootstrap]", postError });
  onSpy.mockRestore();
  return {
    triggerUncaught: (reason: unknown) => handlers["uncaughtException"](reason),
    triggerRejection: (reason: unknown) => handlers["unhandledRejection"](reason),
    postError,
  };
}

describe("installBootstrapErrorGuard", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Run scheduled exit synchronously so we can assert on it.
    vi.spyOn(global, "setImmediate").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Immediate;
    }) as typeof setImmediate);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers both process error handlers", () => {
    const onSpy = vi.spyOn(process, "on");
    installBootstrapErrorGuard({ label: "[TestBootstrap]", postError: vi.fn() });
    const events = onSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("uncaughtException");
    expect(events).toContain("unhandledRejection");
  });

  it("posts the serialized error and exits on uncaughtException", () => {
    const { triggerUncaught, postError } = install();
    const err = new Error("dlopen failed");
    triggerUncaught(err);
    expect(postError).toHaveBeenCalledTimes(1);
    expect(postError).toHaveBeenCalledWith(err.stack ?? err.message);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("posts the serialized error and exits on unhandledRejection", () => {
    const { triggerRejection, postError } = install();
    const err = new Error("ERR_DLOPEN_FAILED");
    triggerRejection(err);
    expect(postError).toHaveBeenCalledWith(err.stack ?? err.message);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("only reports once when the handler fires twice (double-exit guard)", () => {
    const { triggerUncaught, triggerRejection, postError } = install();
    triggerUncaught(new Error("first"));
    triggerRejection(new Error("second"));
    expect(postError).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("still exits when postError throws", () => {
    const postError = vi.fn(() => {
      throw new Error("parentPort gone");
    });
    const { triggerUncaught } = install(postError);
    expect(() => triggerUncaught(new Error("boom"))).not.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("serializes non-Error reasons without throwing", () => {
    const { triggerRejection, postError } = install();
    triggerRejection("string failure");
    expect(postError).toHaveBeenCalledWith("string failure");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("serializes null/undefined reasons", () => {
    const { triggerRejection, postError } = install();
    triggerRejection(undefined);
    expect(postError).toHaveBeenCalledWith("undefined");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
