import { describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import {
  assembleKeyterms,
  tokenizeBranchName,
  tokenizeProjectName,
  extractTerminalIdentifiers,
} from "../voiceContextKeyterms.js";

const gitListBranchesMock = vi.fn().mockResolvedValue([
  { name: "feature/auth-login-service", current: true, commit: "abc123" },
  { name: "main", current: false, commit: "def456" },
]);

vi.mock("../GitService.js", () => ({
  GitService: class MockGitService {
    listBranches(...args: unknown[]) {
      return gitListBranchesMock(...args);
    }
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

function makePtyClient(lines: string[] = []): Pick<PtyClient, "getAllTerminalSnapshots"> {
  return {
    getAllTerminalSnapshots: vi.fn().mockResolvedValue([
      {
        id: "t1",
        lines,
        lastInputTime: 0,
        lastOutputTime: 0,
        lastCheckTime: 0,
        spawnedAt: 0,
      },
    ]),
  };
}

describe("tokenizeBranchName", () => {
  it("splits on / - _ and filters short parts", () => {
    const tokens = tokenizeBranchName("feature/issue-2820-inject-dynamic-project-context");
    expect(tokens).toContain("feature");
    expect(tokens).toContain("inject");
    expect(tokens).toContain("dynamic");
    expect(tokens).toContain("project");
    expect(tokens).toContain("context");
    // "2820" is pure numeric, should be filtered
    expect(tokens).not.toContain("2820");
  });

  it("filters parts shorter than 4 chars", () => {
    const tokens = tokenizeBranchName("fix/ui-btn-update");
    expect(tokens).not.toContain("fix");
    expect(tokens).not.toContain("ui");
    expect(tokens).not.toContain("btn");
    expect(tokens).toContain("update");
  });
});

describe("tokenizeProjectName", () => {
  it("splits on whitespace and separators", () => {
    const tokens = tokenizeProjectName("My Cool Project");
    expect(tokens).toContain("Cool");
    expect(tokens).toContain("Project");
  });

  it("splits camelCase", () => {
    const tokens = tokenizeProjectName("myProjectEditor");
    expect(tokens).toContain("Project");
    expect(tokens).toContain("Editor");
    // "my" is too short (< 4 chars) and gets filtered
    expect(tokens).not.toContain("my");
  });
});

describe("extractTerminalIdentifiers", () => {
  it("extracts snake_case and kebab-case identifiers", () => {
    const lines = ["const user_name = getUserProfile();", "npm run build-project"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids).toContain("user_name");
    expect(ids).toContain("build-project");
  });

  it("extracts camelCase identifiers", () => {
    const lines = ["const userName = getUserProfile();"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids).toContain("getUserProfile");
  });

  it("strips ANSI escape sequences", () => {
    const lines = ["\u001b[32mgetUserProfile\u001b[0m = someValue"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids).toContain("getUserProfile");
  });

  it("deduplicates case-insensitively", () => {
    const lines = ["getUserProfile", "getuserprofile", "GETUSERPROFILE"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids.length).toBe(1);
  });

  it("filters blocklisted keywords", () => {
    const lines = ["function myFunc() { return null; }"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids).not.toContain("function");
    expect(ids).not.toContain("return");
    expect(ids).not.toContain("null");
  });
});

describe("assembleKeyterms", () => {
  it("preserves custom dictionary with highest priority", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["Daintree", "Deepgram", "xterm"],
    });
    expect(result[0]).toBe("Daintree");
    expect(result[1]).toBe("Deepgram");
    expect(result[2]).toBe("xterm");
  });

  it("adds project name tokens", async () => {
    const result = await assembleKeyterms({
      customDictionary: [],
      projectName: "CanopyEditor",
    });
    expect(result).toContain("CanopyEditor");
  });

  it("adds branch name tokens when projectPath provided", async () => {
    const result = await assembleKeyterms({
      customDictionary: [],
      projectPath: "/some/path",
    });
    // From mock: "feature/auth-login-service"
    expect(result).toContain("auth");
    expect(result).toContain("login");
    expect(result).toContain("service");
  });

  it("adds terminal identifiers when ptyClient provided", async () => {
    const ptyClient = makePtyClient(["const myVariable = handleRequest();"]) as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: [],
      ptyClient,
    });
    expect(result).toContain("myVariable");
    expect(result).toContain("handleRequest");
  });

  it("deduplicates case-insensitively", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["Daintree", "daintree", "CANOPY"],
    });
    expect(result.filter((t) => t.toLowerCase() === "daintree").length).toBe(1);
  });

  it("caps at 80 keyterms", async () => {
    const dictionary = Array.from({ length: 100 }, (_, i) => `customTerm${i}`);
    const result = await assembleKeyterms({
      customDictionary: dictionary,
    });
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("falls back gracefully when git fails", async () => {
    gitListBranchesMock.mockRejectedValueOnce(new Error("git not found"));
    const result = await assembleKeyterms({
      customDictionary: ["MyTerm"],
      projectPath: "/some/path",
    });
    expect(result).toContain("MyTerm");
  });

  it("falls back gracefully when ptyClient fails", async () => {
    const ptyClient = {
      getAllTerminalSnapshots: vi.fn().mockRejectedValue(new Error("pty error")),
    } as unknown as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: ["MyTerm"],
      ptyClient,
    });
    expect(result).toContain("MyTerm");
  });

  it("filters blank and numeric-only custom dictionary entries", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["", "  ", "12345", "ValidTerm"],
    });
    expect(result).toContain("ValidTerm");
    expect(result).not.toContain("");
    expect(result).not.toContain("12345");
  });

  it("preserves priority order: custom dict > project name > branch > terminal", async () => {
    const ptyClient = makePtyClient(["const terminalIdent = true;"]) as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: ["CustomFirst"],
      projectName: "ProjectSecond",
      projectPath: "/some/path",
      ptyClient,
    });
    const customIdx = result.indexOf("CustomFirst");
    const projectIdx = result.indexOf("ProjectSecond");
    expect(customIdx).toBeLessThan(projectIdx);
  });
});
