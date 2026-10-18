import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const runMock = vi.fn();

vi.mock("../../ProjectCommandService.js", () => ({
  projectCommandService: { run: (...args: unknown[]) => runMock(...args) },
}));

const { handleProjectRunCommand } = await import("../projectCommand.js");
const {
  PROJECT_COMMAND_MAX_LENGTH,
  PROJECT_COMMAND_MAX_OUTPUT_BYTES,
  PROJECT_COMMAND_MIN_TIMEOUT_MS,
  PROJECT_COMMAND_MAX_TIMEOUT_MS,
} = await import("../../../../shared/types/projectCommand.js");

const baseResult = {
  projectId: "proj-1",
  cwd: "/repo",
  exitCode: 3,
  signalName: "SIGTERM",
  durationMs: 1234,
  timedOut: true,
  aborted: false,
  output: "ok\n",
  outputTruncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  runMock.mockResolvedValue(baseResult);
});

describe("handleProjectRunCommand — argument validation", () => {
  it.each([
    ["missing args", undefined],
    ["a non-object", "git status"],
    ["an array", []],
    ["a blank projectId", { projectId: " ", command: "ls" }],
    ["a blank command", { projectId: "proj-1", command: "   " }],
    ["a command with NUL", { projectId: "proj-1", command: "ls\0rm" }],
    [
      "an over-long command",
      { projectId: "proj-1", command: "x".repeat(PROJECT_COMMAND_MAX_LENGTH + 1) },
    ],
    ["a blank cwd", { projectId: "proj-1", command: "ls", cwd: "" }],
    ["a fractional timeout", { projectId: "proj-1", command: "ls", timeoutMs: 1500.5 }],
    [
      "a timeout under the bound",
      { projectId: "proj-1", command: "ls", timeoutMs: PROJECT_COMMAND_MIN_TIMEOUT_MS - 1 },
    ],
    [
      "a timeout over the bound",
      { projectId: "proj-1", command: "ls", timeoutMs: PROJECT_COMMAND_MAX_TIMEOUT_MS + 1 },
    ],
  ])("rejects %s with InvalidParams before running anything", async (_label, rawArgs) => {
    await expect(handleProjectRunCommand(rawArgs)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("passes the command through untouched, so the audited text is what ran", async () => {
    await handleProjectRunCommand({
      projectId: " proj-1 ",
      command: "  git status  ",
      cwd: "/wt ",
    });

    expect(runMock.mock.calls[0]?.[0]).toEqual({
      projectId: "proj-1",
      command: "  git status  ",
      cwd: "/wt",
      timeoutMs: undefined,
    });
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    await handleProjectRunCommand({ projectId: "proj-1", command: "ls" }, controller.signal);

    expect(runMock.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });
});

describe("handleProjectRunCommand — wire projection", () => {
  it("maps every field from its own source", async () => {
    const result = await handleProjectRunCommand({ projectId: "proj-1", command: "ls" });

    expect(result).toEqual(baseResult);
  });

  it("drops anything the service adds beyond the contract", async () => {
    runMock.mockResolvedValue({ ...baseResult, env: { SECRET: "x" } });

    const result = await handleProjectRunCommand({ projectId: "proj-1", command: "ls" });

    expect(result).not.toHaveProperty("env");
  });

  it("caps oversized output and says so", async () => {
    runMock.mockResolvedValue({
      ...baseResult,
      output: "y".repeat(PROJECT_COMMAND_MAX_OUTPUT_BYTES * 2),
      outputTruncated: false,
    });

    const result = await handleProjectRunCommand({ projectId: "proj-1", command: "ls" });

    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(
      PROJECT_COMMAND_MAX_OUTPUT_BYTES
    );
    expect(result.outputTruncated).toBe(true);
  });
});
