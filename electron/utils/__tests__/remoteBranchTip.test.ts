import { describe, expect, it, vi } from "vitest";
import { readRemoteBranchTip } from "../remoteBranchTip.js";

const SHA = "a".repeat(40);

describe("readRemoteBranchTip", () => {
  it("reads the tip the remote reports, asking for the full ref", async () => {
    const raw = vi.fn(async () => `${SHA}\trefs/heads/feature/x\n`);
    expect(await readRemoteBranchTip({ raw }, "upstream", "feature/x")).toBe(SHA);
    expect(raw).toHaveBeenCalledWith([
      "ls-remote",
      "--heads",
      "--",
      "upstream",
      "refs/heads/feature/x",
    ]);
  });

  it("answers null when the remote replied without the branch", async () => {
    expect(await readRemoteBranchTip({ raw: async () => "\n" }, "origin", "x")).toBeNull();
  });

  it("answers undefined when the remote couldn't be asked or replied with garbage", async () => {
    const failing = { raw: async () => Promise.reject(new Error("unreachable")) };
    expect(await readRemoteBranchTip(failing, "origin", "x")).toBeUndefined();
    expect(
      await readRemoteBranchTip({ raw: async () => "nonsense\tref" }, "origin", "x")
    ).toBeUndefined();
  });

  it("gives up after its timeout", async () => {
    const slow = { raw: () => new Promise<string>(() => {}) };
    expect(await readRemoteBranchTip(slow, "origin", "x", 10)).toBeUndefined();
  });
});
