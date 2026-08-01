import { describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import {
  assembleKeyterms,
  formatKeytermPrompt,
  sanitizeOpenAIKeywords,
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

  it("caps each term at 100 chars (Deepgram keyterm limit)", async () => {
    const longTerm = "a".repeat(150);
    const result = await assembleKeyterms({
      customDictionary: [longTerm],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(100);
    expect(result[0]).toBe("a".repeat(100));
  });

  it("dedupes terms that collide only after the 100-char cap", async () => {
    // Two terms identical for the first 100 chars but differing past it cap to
    // the same value and must collapse to one entry.
    const base = "x".repeat(100);
    const result = await assembleKeyterms({
      customDictionary: [base + "AAAA", base + "BBBB"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(base);
  });

  it("merges concurrently-read sources in priority order when branch fails", async () => {
    // Branch read fails, terminal read succeeds — the surviving terminal
    // identifiers still land after custom/project tokens, never lost to the
    // concurrent failure.
    gitListBranchesMock.mockRejectedValueOnce(new Error("git not found"));
    const ptyClient = makePtyClient(["const terminalIdent = true;"]) as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: ["CustomFirst"],
      projectName: "ProjectSecond",
      projectPath: "/some/path",
      ptyClient,
    });
    expect(result).toContain("CustomFirst");
    expect(result).toContain("terminalIdent");
    expect(result).not.toContain("auth"); // branch tokens absent on failure
    expect(result.indexOf("CustomFirst")).toBeLessThan(result.indexOf("terminalIdent"));
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

describe("sanitizeOpenAIKeywords", () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);

  it("passes through safe terms unchanged and in order", () => {
    expect(sanitizeOpenAIKeywords(["Daintree", "xterm", "PtyClient"])).toEqual([
      "Daintree",
      "xterm",
      "PtyClient",
    ]);
  });

  it("preserves internal spaces, punctuation, and casing in literal terms", () => {
    expect(sanitizeOpenAIKeywords(["AC-42", "Premium Plus", "node_modules"])).toEqual([
      "AC-42",
      "Premium Plus",
      "node_modules",
    ]);
  });

  it.each([
    ["less-than", "<div>"],
    ["greater-than", "a->b"],
    ["carriage return", `foo${CR}bar`],
    ["line feed", `foo${LF}bar`],
  ])("drops a term containing %s", (_label, term) => {
    expect(sanitizeOpenAIKeywords([term])).toEqual([]);
  });

  it("drops the whole offending term rather than stripping the character", () => {
    // Stripping would yield "div" — a different literal the user never typed,
    // biasing transcription toward a word that isn't on their screen.
    const result = sanitizeOpenAIKeywords(["<div>"]);
    expect(result).toEqual([]);
    expect(result).not.toContain("div");
  });

  it("keeps safe terms that surround a rejected one", () => {
    expect(sanitizeOpenAIKeywords(["Daintree", "a<b", "xterm"])).toEqual(["Daintree", "xterm"]);
  });

  it("lets later safe terms fill capacity freed by rejected entries", () => {
    // A rejected term must consume no slot: sanitizing with and without the bad
    // prefix has to yield exactly the same list, even past the count cap.
    const safe = Array.from({ length: 60 }, (_, i) => `term${i}`);
    expect(sanitizeOpenAIKeywords(["bad<term", ...safe])).toEqual(sanitizeOpenAIKeywords(safe));
  });

  it("trims surrounding whitespace and drops empty results", () => {
    expect(sanitizeOpenAIKeywords(["  Daintree  ", "   ", "\t", "xterm"])).toEqual([
      "Daintree",
      "xterm",
    ]);
  });

  it("deduplicates case-insensitively, keeping the first spelling", () => {
    expect(sanitizeOpenAIKeywords(["Daintree", "daintree", "DAINTREE", "xterm"])).toEqual([
      "Daintree",
      "xterm",
    ]);
  });

  it("deduplicates terms that collapse to the same value only after trimming", () => {
    expect(sanitizeOpenAIKeywords(["Daintree", "  Daintree  "])).toEqual(["Daintree"]);
  });

  it("caps term length and dedups terms that collide only after capping", () => {
    // Two distinct inputs sharing a long prefix must collapse to one entry once
    // both are capped — asserted against the cap's own output rather than a
    // repeated literal, so retuning the bound doesn't invalidate the invariant.
    const long = "a".repeat(150);
    const [capped] = sanitizeOpenAIKeywords([long]);
    expect(capped.length).toBeLessThan(long.length);
    expect(sanitizeOpenAIKeywords([long, `${long}bbb`])).toEqual([capped]);
  });

  it("does not split a surrogate pair when capping", () => {
    // A bare slice at the boundary leaves a lone high surrogate, which
    // serializes as malformed UTF-8 the server may reject.
    const [capped] = sanitizeOpenAIKeywords(["a".repeat(150) + "😀"]);
    expect(JSON.stringify(capped)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it("keeps a non-BMP character intact when it straddles the cap boundary", () => {
    const emoji = "😀";
    // Pad so the emoji's surrogate pair spans the cap: the pair is dropped
    // whole, never halved.
    const [capped] = sanitizeOpenAIKeywords(["a".repeat(99) + emoji + "b".repeat(50)]);
    expect(JSON.stringify(capped)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it("caps the total number of terms to a stable prefix of the input", () => {
    const input = Array.from({ length: 200 }, (_, i) => `term${i}`);
    const result = sanitizeOpenAIKeywords(input);
    expect(result.length).toBeLessThan(input.length);
    // Order-preserving prefix — the cap drops the tail, it doesn't reshuffle.
    expect(result).toEqual(input.slice(0, result.length));
  });

  it("frees capacity when a duplicate collapses, not just when a term is rejected", () => {
    const unique = Array.from({ length: 200 }, (_, i) => `term${i}`);
    const withDupes = ["term0", "TERM0", ...unique];
    // Duplicates must not consume slots that unique terms could have used.
    expect(sanitizeOpenAIKeywords(withDupes)).toEqual(sanitizeOpenAIKeywords(unique));
  });

  it("rejects a forbidden character that sits beyond the length cap", () => {
    // Rejection must run on the whole trimmed term, before capping — otherwise
    // capping would hide the character and let the term through.
    expect(sanitizeOpenAIKeywords(["a".repeat(150) + "<"])).toEqual([]);
  });

  it("preserves non-ASCII terms and dedups them case-insensitively", () => {
    expect(sanitizeOpenAIKeywords(["Kubernetes", "café", "CAFÉ", "日本語"])).toEqual([
      "Kubernetes",
      "café",
      "日本語",
    ]);
  });

  it("returns an empty array when every term is unsafe", () => {
    expect(sanitizeOpenAIKeywords(["<a>", `b${LF}c`, "   ", "c>d"])).toEqual([]);
  });

  it("trims a trailing newline rather than rejecting the term", () => {
    // Trimming yields the same term the user meant; only an INTERNAL CR/LF
    // (a multi-line blob) is grounds for dropping it.
    expect(sanitizeOpenAIKeywords([`Daintree${LF}`, `xterm${CR}`])).toEqual(["Daintree", "xterm"]);
  });

  it("returns an empty array for empty input", () => {
    expect(sanitizeOpenAIKeywords([])).toEqual([]);
  });

  it("ignores non-string entries defensively", () => {
    const hostile = ["Daintree", null, undefined, 42, { term: "x" }] as unknown as string[];
    expect(sanitizeOpenAIKeywords(hostile)).toEqual(["Daintree"]);
  });

  it("does not mutate the input array", () => {
    // The session keyterm snapshot is frozen and reused across reconnects.
    const input = Object.freeze(["Daintree", "<bad>", "xterm"]);
    expect(sanitizeOpenAIKeywords(input)).toEqual(["Daintree", "xterm"]);
    expect(input).toEqual(["Daintree", "<bad>", "xterm"]);
  });

  it("produces a prompt free of rejected terms when composed with formatKeytermPrompt", () => {
    const prompt = formatKeytermPrompt(sanitizeOpenAIKeywords(["Daintree", "<script>", "xterm"]));
    expect(prompt).toBe("Keywords: Daintree, xterm");
    expect(prompt).not.toContain("script");
  });
});
