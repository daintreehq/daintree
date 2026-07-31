import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

const runCheckMock = vi.fn();

vi.mock("../../ProjectCheckService.js", () => ({
  projectCheckService: { runCheck: (...args: unknown[]) => runCheckMock(...args) },
}));

const { handleProjectRunCheck } = await import("../projectCheck.js");

const baseResult = {
  projectId: "proj-1",
  cwd: "/repo",
  runnerId: "npm:test",
  runnerName: "test",
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
    ["a non-object", "npm:test"],
    ["an array", []],
  ])("rejects %s with InvalidParams", async (_label, rawArgs) => {
    await expect(handleProjectRunCheck(rawArgs)).rejects.toBeInstanceOf(McpError);
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it.each(["projectId", "runnerId"])("rejects a blank %s", async (field) => {
    const args: Record<string, unknown> = { projectId: "proj-1", runnerId: "npm:test" };
    args[field] = "   ";
    await expect(handleProjectRunCheck(args)).rejects.toBeInstanceOf(McpError);
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it("rejects a timeoutMs outside the supported range", async () => {
    await expect(
      handleProjectRunCheck({ projectId: "p", runnerId: "r", timeoutMs: 999_999_999 })
    ).rejects.toBeInstanceOf(McpError);
    await expect(
      handleProjectRunCheck({ projectId: "p", runnerId: "r", timeoutMs: 10 })
    ).rejects.toBeInstanceOf(McpError);
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric timeoutMs", async () => {
    await expect(
      handleProjectRunCheck({ projectId: "p", runnerId: "r", timeoutMs: "60000" })
    ).rejects.toBeInstanceOf(McpError);
  });

  it("trims string args and forwards the optional ones", async () => {
    const signal = new AbortController().signal;
    await handleProjectRunCheck(
      { projectId: " proj-1 ", runnerId: " npm:test ", cwd: " /wt/a ", timeoutMs: 60_000 },
      signal
    );

    expect(runCheckMock).toHaveBeenCalledWith(
      { projectId: "proj-1", runnerId: "npm:test", cwd: "/wt/a", timeoutMs: 60_000 },
      { signal }
    );
  });

  it("omits cwd and timeoutMs when not supplied", async () => {
    await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm:test" });

    expect(runCheckMock).toHaveBeenCalledWith(
      { projectId: "proj-1", runnerId: "npm:test", cwd: undefined, timeoutMs: undefined },
      { signal: undefined }
    );
  });
});

describe("handleProjectRunCheck — result projection", () => {
  it("returns exactly the documented fields", async () => {
    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm:test" });
    expect(Object.keys(result).sort()).toEqual(Object.keys(baseResult).sort());
  });

  it("drops fields the service did not promise", async () => {
    // `resultSchema` is manifest documentation and never validates run()'s
    // return, so this hand-built projection is the only thing keeping service
    // internals off the wire (#10870).
    runCheckMock.mockResolvedValue({ ...baseResult, internalPid: 4242, command: "npm run test" });

    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm:test" });

    expect(result).not.toHaveProperty("internalPid");
    // The raw command is deliberately not echoed back to the caller.
    expect(result).not.toHaveProperty("command");
  });

  it("caps oversized output even if the service returned more", async () => {
    runCheckMock.mockResolvedValue({ ...baseResult, output: "y".repeat(80 * 1024) });

    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm:test" });

    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(50 * 1024 + 32);
    expect(result.output).toContain("[truncated]");
  });

  it("passes a failing check straight through rather than throwing", async () => {
    runCheckMock.mockResolvedValue({ ...baseResult, passed: false, exitCode: 2 });

    const result = await handleProjectRunCheck({ projectId: "proj-1", runnerId: "npm:test" });

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
