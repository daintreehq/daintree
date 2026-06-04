import { describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import {
  assembleKeyterms,
  formatKeytermPrompt,
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

  it("ranks higher-frequency terms ahead of lower-frequency ones", () => {
    // rare_term appears first (earliest line) but on only one line; common_term
    // appears on three distinct lines. Frequency must beat first-seen order.
    const lines = ["rare_term", "common_term", "common_term filler_one", "common_term"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids.indexOf("common_term")).toBeLessThan(ids.indexOf("rare_term"));
  });

  it("breaks frequency ties by recency (later line wins)", () => {
    // Both terms appear exactly once; the one on the later line ranks higher.
    const lines = ["early_term", "middle_filler", "late_term"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids.indexOf("late_term")).toBeLessThan(ids.indexOf("early_term"));
  });

  it("counts repeated occurrences on a single line only once", () => {
    // spammy_term repeats many times on one line; steady_term appears on two
    // distinct lines. Per-line counting means steady_term has higher frequency.
    const lines = ["spammy_term spammy_term spammy_term spammy_term", "steady_term", "steady_term"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids.indexOf("steady_term")).toBeLessThan(ids.indexOf("spammy_term"));
  });

  it("lets a recent single occurrence outrank an older repeated one (composite score)", () => {
    // Documents the intentional multiplicative design: frequency and recency
    // combine, so a term seen once at the very end can outscore one seen a few
    // times early. frequent_term: lines 0-2 → 3*3=9; latest_term: line 9 → 1*10=10.
    const lines = [
      "frequent_term",
      "frequent_term",
      "frequent_term",
      "filler_three",
      "filler_four",
      "filler_five",
      "filler_six",
      "filler_seven",
      "filler_eight",
      "latest_term",
    ];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids.indexOf("latest_term")).toBeLessThan(ids.indexOf("frequent_term"));
  });

  it("orders equal-score terms deterministically by canonical form", () => {
    // Two single-occurrence terms on the same line have identical scores;
    // the lexically lesser one comes first, deterministically.
    const lines = ["zebra_term alpha_term"];
    const ids = extractTerminalIdentifiers(lines);
    expect(ids).toEqual(["alpha_term", "zebra_term"]);
  });
});

describe("assembleKeyterms", () => {
  it("preserves custom dictionary with highest priority", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["Daintree", "Whisper", "xterm"],
    });
    expect(result[0]).toBe("Daintree");
    expect(result[1]).toBe("Whisper");
    expect(result[2]).toBe("xterm");
  });

  it("adds project name tokens", async () => {
    const result = await assembleKeyterms({
      customDictionary: [],
      projectName: "DaintreeEditor",
    });
    expect(result).toContain("DaintreeEditor");
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
      customDictionary: ["Daintree", "daintree", "FOREST"],
    });
    expect(result.filter((t) => t.toLowerCase() === "daintree").length).toBe(1);
  });

  it("caps total keyterms at MAX_KEYTERMS", async () => {
    const dictionary = Array.from({ length: 80 }, (_, i) => `customTerm${i}`);
    const result = await assembleKeyterms({
      customDictionary: dictionary,
    });
    // More candidates supplied than the cap allows, so the result is bounded
    // below the input size. Asserting the relationship (truncation occurred),
    // not the literal cap constant.
    expect(result.length).toBeLessThan(dictionary.length);
    expect(result.length).toBeGreaterThan(20);
  });

  it("caps terminal lines at 200 and ranks the newest by recency", async () => {
    // 4 terminals × 60 lines = 240 total. Each line carries one unique
    // identifier so frequency is constant (1 line each) and recency — the line
    // position — is the sole ranking signal. The oldest 40 lines fall outside
    // the 200-line tail window; within the window, the terminal-tier cap keeps
    // only the most recent identifiers.
    const snapshots = Array.from({ length: 4 }, (_, termIdx) => ({
      id: `t${termIdx}`,
      lines: Array.from({ length: 60 }, (_, lineIdx) => {
        const globalLine = termIdx * 60 + lineIdx;
        return `term${termIdx}_ident_${globalLine}`;
      }),
      lastInputTime: 0,
      lastOutputTime: 0,
      lastCheckTime: 0,
      spawnedAt: 0,
    }));
    const ptyClient = {
      getAllTerminalSnapshots: vi.fn().mockResolvedValue(snapshots),
    } as unknown as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: [],
      ptyClient,
    });
    // Identifiers from the first 40 lines (globally 0-39) are dropped by the tail slice.
    expect(result).not.toContain("term0_ident_0");
    expect(result).not.toContain("term0_ident_39");
    // The very newest identifier survives and the oldest windowed one (line 40,
    // lowest recency) is squeezed out by the terminal-tier cap.
    expect(result).toContain("term3_ident_239");
    expect(result).not.toContain("term0_ident_40");
    // Recency ranking: a more recent identifier outranks a less recent one.
    expect(result.indexOf("term3_ident_239")).toBeLessThan(result.indexOf("term3_ident_220"));
    // The cap truncates far below the 200-line window size.
    expect(result.length).toBeLessThan(200);
  });

  it("bounds the terminal tier and preserves headroom for other tiers", async () => {
    // Far more unique terminal identifiers than the terminal tier allows, plus a
    // handful of high-priority dictionary terms. The dictionary terms must all
    // survive (the terminal flood can't crowd them out) and the terminal-derived
    // contribution must be bounded well below what was supplied.
    const dictTerms = ["AlphaKeyword", "BetaKeyword", "GammaKeyword"];
    const lines = Array.from({ length: 60 }, (_, i) => `terminal_ident_${i}`);
    const ptyClient = makePtyClient(lines) as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: dictTerms,
      ptyClient,
    });
    for (const term of dictTerms) {
      expect(result).toContain(term);
    }
    const terminalCount = result.filter((t) => t.startsWith("terminal_ident_")).length;
    expect(terminalCount).toBeLessThan(lines.length);
    // The newest terminal identifier (highest recency) is kept; the oldest is dropped.
    expect(result).toContain("terminal_ident_59");
    expect(result).not.toContain("terminal_ident_0");
  });

  it("does not let a dict/terminal collision consume terminal tier capacity", async () => {
    // The newest terminal identifier also sits in the dictionary, so the
    // terminal-tier loop hits a dedup miss on it. The counter must only advance
    // on a successful add — otherwise the duplicate would burn a tier slot and
    // the tier would yield one fewer unique terminal term.
    const lines = Array.from({ length: 60 }, (_, i) => `terminal_ident_${i}`);
    const ptyClient = makePtyClient(lines) as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: ["terminal_ident_59"],
      ptyClient,
    });
    // Recency ranks 59→0; 59 is the dict dup. The tier should still fill with
    // the next-newest unique terms down to terminal_ident_29 (30 unique slots).
    expect(result).toContain("terminal_ident_29");
    expect(result).not.toContain("terminal_ident_28");
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
    // Branch mock is "feature/auth-login-service" → tokens: feature, auth, login, service
    const branchIdx = result.indexOf("auth");
    const terminalIdx = result.indexOf("terminalIdent");
    expect(customIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(branchIdx);
    expect(branchIdx).toBeLessThan(terminalIdx);
  });
});

describe("formatKeytermPrompt", () => {
  it("joins terms into the OpenAI prompt string format", () => {
    expect(formatKeytermPrompt(["foo", "bar", "baz"])).toBe("Keywords: foo, bar, baz");
  });

  it("returns empty string for empty array", () => {
    expect(formatKeytermPrompt([])).toBe("");
  });

  it("formats a single term without a trailing separator", () => {
    expect(formatKeytermPrompt(["Daintree"])).toBe("Keywords: Daintree");
  });

  it("preserves casing of terms", () => {
    expect(formatKeytermPrompt(["Daintree", "xterm", "PtyClient"])).toBe(
      "Keywords: Daintree, xterm, PtyClient"
    );
  });

  it("drops whole terms that would exceed the char cap (never mid-term truncation)", () => {
    // "Keywords: foo" = 13 chars. ", toolong_word_here" would push to 32.
    const result = formatKeytermPrompt(["foo", "toolong_word_here"], 20);
    expect(result).toBe("Keywords: foo");
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("returns empty string when the first term alone exceeds the cap", () => {
    // "Keywords: averylongtermthatcannotfit" exceeds 20 chars
    expect(formatKeytermPrompt(["averylongtermthatcannotfit"], 20)).toBe("");
  });

  it("includes a term whose total length lands exactly at the cap", () => {
    // "Keywords: abc" is exactly 13 chars; cap of 13 must include it.
    expect(formatKeytermPrompt(["abc"], 13)).toBe("Keywords: abc");
  });

  it("skips blank terms in the input", () => {
    expect(formatKeytermPrompt(["foo", "", "bar"])).toBe("Keywords: foo, bar");
  });

  it("caps the full string (including the prefix) at maxChars", () => {
    const many = Array.from({ length: 200 }, (_, i) => `term${i}`);
    const result = formatKeytermPrompt(many);
    expect(result.length).toBeLessThanOrEqual(400);
    expect(result.startsWith("Keywords: ")).toBe(true);
  });

  it("appends as many terms as fit within the cap, in input order", () => {
    // Each "abc" pair = 5 chars after the first ("abc" then ", abc").
    // "Keywords: abc" = 13, +", abc" = 18, +", abc" = 23.
    const result = formatKeytermPrompt(["abc", "abc1", "abc2", "abc3"], 23);
    expect(result).toBe("Keywords: abc, abc1");
  });

  it("skips an over-cap term mid-list and continues to later terms that fit", () => {
    // "Keywords: foo" = 13. "averylongterm_skip_me" alone added would push to 36 (> 20).
    // "Keywords: foo, bar" = 18 (≤ 20). Skip semantics keep "bar" reachable.
    const result = formatKeytermPrompt(["foo", "averylongterm_skip_me", "bar"], 20);
    expect(result).toBe("Keywords: foo, bar");
  });

  it("returns empty string when every term is over the cap", () => {
    expect(formatKeytermPrompt(["averylongterm1", "averylongterm2"], 15)).toBe("");
  });

  it("returns empty string when maxChars is smaller than the prefix alone", () => {
    // "Keywords: " is 10 chars; "abc" pushes candidate to 13 — nothing can fit at cap 8.
    expect(formatKeytermPrompt(["abc"], 8)).toBe("");
  });

  it("skips whitespace-only terms defensively", () => {
    expect(formatKeytermPrompt(["   ", "\t\n", "foo"])).toBe("Keywords: foo");
  });
});
