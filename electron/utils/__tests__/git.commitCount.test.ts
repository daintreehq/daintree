import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGit = {
  raw: vi.fn(),
};

vi.mock("../hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockGit),
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { getCommitCount } from "../git.js";

// `getCommitCount` reports a *reliable* count or throws — it deliberately does
// not report `0` for a failure, because callers persist the result and a
// fabricated zero would overwrite a good stored count (issue #11078).
describe("getCommitCount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function respond(handler: (args: string[]) => Promise<string>) {
    mockGit.raw.mockImplementation((args: string[]) => handler(args));
  }

  it("returns the parsed count on the happy path", async () => {
    respond(async (args) => (args[0] === "rev-list" ? "1234\n" : ""));
    await expect(getCommitCount("/repo")).resolves.toBe(1234);
  });

  it("reports zero for a repository whose HEAD is unborn", async () => {
    // `git init` with nothing committed: `rev-list HEAD` fails, but the repo is
    // real and its count is genuinely 0. Throwing here would mean an empty repo
    // could never persist a count — and so could never seed its toolbar.
    respond(async (args) => {
      if (args[0] === "rev-list") throw new Error("fatal: ambiguous argument 'HEAD'");
      if (args[0] === "rev-parse") return ".git\n";
      return "";
    });

    await expect(getCommitCount("/empty-repo")).resolves.toBe(0);
  });

  it("throws when the directory is not a usable repository", async () => {
    respond(async () => {
      throw new Error("fatal: not a git repository");
    });

    await expect(getCommitCount("/not-a-repo")).rejects.toThrow(/not a git repository/);
  });

  it("does not report an unparseable answer as a count", async () => {
    // An empty or garbage `rev-list` answer parses to NaN. Reporting that as a
    // number would let NaN reach the count columns.
    respond(async (args) => {
      if (args[0] === "rev-list") return "\n";
      throw new Error("fatal: not a git repository");
    });

    await expect(getCommitCount("/weird")).rejects.toThrow();
  });
});
