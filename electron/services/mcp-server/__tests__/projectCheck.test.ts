import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const runCheckMock = vi.fn();

vi.mock("../../ProjectCheckService.js", () => ({
  projectCheckService: { runCheck: (...args: unknown[]) => runCheckMock(...args) },
}));

const { handleProjectRunCheck } = await import("../projectCheck.js");
const {
  PROJECT_CHECK_MAX_OUTPUT_BYTES,
  PROJECT_CHECK_MIN_TIMEOUT_MS,
  PROJECT_CHECK_MAX_TIMEOUT_MS,
} = await import("../../../../shared/types/projectCheck.js");

// Every field carries a distinct sentinel so the projection test catches a
// field mapped from the wrong source property, not just a missing key.
const baseResult = {
  projectId: "proj-1",
  cwd: "/repo",
  runnerId: "npm-test",
  runnerName: "test",
  command: "npm run test",
  passed: true,
  exitCode: 0,
  signalName: null,
  durationMs: 1234,
  timedOut: false,
  aborted: false,
  output: "ok\n",
  outputTruncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  runCheckMock.mockResolvedValue(baseResult);
});

describe("handleProjectRunCheck — argument validation", () => {
  it.each([
    ["missing args", undefined],
    ["a non-object", "npm-test"],
    ["an array", []],
  ])("rejects %s with InvalidParams", async (_label, rawArgs) => {
    await expect(handleProjectRunCheck(rawArgs)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it.each(["projectId", "runnerId"])("rejects a blank %s", async (field) => {
    const args: Record<string, unknown> = { projectId: "proj-1", runnerId: "npm-test" };
    args[field] = "   ";
    await expect(handleProjectRunCheck(args)).rejects.toBeInstanceOf(McpError);
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it("rejects a timeoutMs outside the supported range but accepts the bounds", async () => {
    await expect(
      handleProjectRunCheck({
        projectId: "p",
        runnerId: "r",
        timeoutMs: PROJECT_CHECK_MAX_TIMEOUT_MS + 1,
      })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      handleProjectRunCheck({
        projectId: "p",
        runnerId: "r",
        timeoutMs: PROJECT_CHECK_MIN_TIMEOUT_MS - 1,
      })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(runCheckMock).not.toHaveBeenCalled();

    // Both bounds are inclusive.
    await handleProjectRunCheck({
      projectId: "p",
      runnerId: "r",
      timeoutMs: PROJECT_CHECK_MIN_TIMEOUT_MS,
    });
    await handleProjectRunCheck({
      projectId: "p",
      runnerId: "r",
      timeoutMs: PROJECT_CHECK_MAX_TIMEOUT_MS,
    });
    expect(runCheckMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a string", "60000"],
    // The action advertises `.int()`. That schema never runs on this path, so
    // accepting fractions here would quietly make the published contract false.
    ["a fraction", 60_000.5],
  ])("rejects %s timeoutMs", async (_label, timeoutMs) => {
    await expect(
      handleProjectRunCheck({ projectId: "p", runnerId: "r", timeoutMs })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it("trims string args and forwards the optional ones", async () => {
    const signal = new AbortController().signal;
    await handleProjectRunCheck(
      { projectId: " proj-1 ", runnerId: " npm-test ", cwd: " /wt/a ", timeoutMs: 60_000 },
      signal
    );

    expect(runCheckMock).toHaveBeenCalledWith(
      { projectId: "proj-1", runnerId: "npm-test", cwd: "/wt/a", timeoutMs: 60_000 },
      { signal }
    );
  });

  it("omits cwd and timeoutMs when not supplied", async () => {
    await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm-test" });

    expect(runCheckMock).toHaveBeenCalledWith(
      { projectId: "proj-1", runnerId: "npm-test", cwd: undefined, timeoutMs: undefined },
      { signal: undefined }
    );
  });
});

describe("handleProjectRunCheck — result projection", () => {
  it("returns exactly the documented fields, each from its own source", async () => {
    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm-test" });
    // Full equality, not a key comparison — a key check would pass even if
    // every value were read from the wrong property.
    expect(result).toEqual(baseResult);
  });

  it("drops fields the service did not promise", async () => {
    // `resultSchema` is manifest documentation and never validates run()'s
    // return, so this hand-built projection is the only thing keeping service
    // internals off the wire (#10870).
    runCheckMock.mockResolvedValue({ ...baseResult, internalPid: 4242, envPath: "/usr/bin" });

    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm-test" });

    expect(result).not.toHaveProperty("internalPid");
    expect(result).not.toHaveProperty("envPath");
  });

  it("flags truncation it performed itself", async () => {
    // The service already caps to the same limit, so this path should be dead.
    // If it ever fires, reporting `outputTruncated: false` alongside clipped
    // text would tell the caller it was seeing the whole failure.
    runCheckMock.mockResolvedValue({
      ...baseResult,
      output: "y".repeat(PROJECT_CHECK_MAX_OUTPUT_BYTES * 2),
      outputTruncated: false,
    });

    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm-test" });

    expect(result.outputTruncated).toBe(true);
  });

  it("caps oversized output even if the service returned more", async () => {
    runCheckMock.mockResolvedValue({
      ...baseResult,
      output: "y".repeat(PROJECT_CHECK_MAX_OUTPUT_BYTES * 2),
    });

    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm-test" });

    // Sized off the exported cap rather than a copied literal, so raising the
    // cap re-exercises the invariant instead of needing a matching test edit.
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(
      PROJECT_CHECK_MAX_OUTPUT_BYTES + 32
    );
    expect(result.output).toContain("[truncated]");
  });

  it("passes a failing check straight through rather than throwing", async () => {
    runCheckMock.mockResolvedValue({ ...baseResult, passed: false, exitCode: 2 });

    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm-test" });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("propagates a service failure-to-start error", async () => {
    runCheckMock.mockRejectedValue(new Error('No runner "nope" detected in /repo.'));

    await expect(handleProjectRunCheck({ projectId: "proj-1", runnerId: "nope" })).rejects.toThrow(
      /No runner/
    );
  });
});
