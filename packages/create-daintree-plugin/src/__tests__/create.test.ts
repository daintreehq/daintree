import { describe, it, expect, vi, afterEach } from "vitest";
import { runNewFromArgv } from "daintree-plugin";

vi.mock("daintree-plugin", () => ({
  runNewFromArgv: vi.fn(async () => undefined),
}));

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.resetModules();
  vi.mocked(runNewFromArgv).mockClear();
});

describe("create-daintree-plugin bin", () => {
  it("forwards every user argument to daintree-plugin's `new` parser", async () => {
    // The bin runs on import; argv beyond node + script is the user's.
    process.argv = ["node", "create.js", "my-plugin", "--publisher", "acme", "--yes"];
    await import("../create.js");
    expect(runNewFromArgv).toHaveBeenCalledWith(["my-plugin", "--publisher", "acme", "--yes"]);
  });

  it("prints the failure message and exits 1 when the scaffold rejects", async () => {
    vi.mocked(runNewFromArgv).mockRejectedValueOnce(new Error("publisher is required"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.argv = ["node", "create.js", "my-plugin"];
      await import("../create.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(error).toHaveBeenCalledWith("publisher is required");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
