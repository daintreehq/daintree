import { describe, it, expect, vi, beforeEach } from "vitest";
import { runNewFromArgv } from "../commands/newCommand.js";
import { runNew } from "../commands/new.js";

vi.mock("../commands/new.js", () => ({
  runNew: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.mocked(runNew).mockClear();
});

describe("runNewFromArgv", () => {
  it("forwards every `new` option, not just the positional name", async () => {
    await runNewFromArgv([
      "my-plugin",
      "--publisher",
      "acme",
      "--template",
      "view",
      "--yes",
      "--project",
    ]);
    expect(runNew).toHaveBeenCalledTimes(1);
    expect(runNew).toHaveBeenCalledWith("my-plugin", {
      publisher: "acme",
      template: "view",
      yes: true,
      project: true,
    });
  });

  it("leaves the name and flags undefined when omitted, so prompts still run", async () => {
    await runNewFromArgv([]);
    expect(runNew).toHaveBeenCalledWith(undefined, {
      publisher: undefined,
      template: undefined,
      yes: undefined,
      project: undefined,
    });
  });

  it("treats --help as a clean exit without running the scaffold", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(runNewFromArgv(["--help"])).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
    expect(runNew).not.toHaveBeenCalled();
  });

  it("treats --version as a clean exit without running the scaffold", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(runNewFromArgv(["--version"])).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
    expect(runNew).not.toHaveBeenCalled();
  });

  it("prints the caller's version for --version when one is passed", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(runNewFromArgv(["--version"], "9.8.7")).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith("9.8.7\n");
    } finally {
      write.mockRestore();
    }
    expect(runNew).not.toHaveBeenCalled();
  });

  it("rejects on an unknown option instead of exiting the process", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runNewFromArgv(["my-plugin", "--bogus"])).rejects.toThrow(/unknown option/);
      expect(exit).not.toHaveBeenCalled();
      expect(runNew).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it("propagates a scaffold failure to the caller", async () => {
    vi.mocked(runNew).mockRejectedValueOnce(new Error("publisher is required"));
    await expect(runNewFromArgv(["my-plugin", "--yes"])).rejects.toThrow("publisher is required");
  });
});
