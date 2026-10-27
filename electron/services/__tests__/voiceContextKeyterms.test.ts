import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import {
  MAX_DICTIONARY_KEYTERMS,
  MAX_KEYTERMS,
  MAX_NAME_KEYTERMS,
} from "../../../shared/config/voiceKeyterms.js";
import {
  assembleKeyterms,
  assembleTaggedKeyterms,
  readPaneKeytermReads,
  screenCorrectionRepositoryNames,
  screenDictationNames,
  screenDictationWorktree,
  formatKeytermPrompt,
  sanitizeOpenAIKeywords,
  tokenizeBranchName,
  tokenizeProjectName,
  extractTerminalIdentifiers,
} from "../voiceContextKeyterms.js";

const getGitBranchMock = vi.fn().mockResolvedValue("feature/auth-login-service");

vi.mock("../../utils/gitUtils.js", () => ({
  getGitBranch: (...args: unknown[]) => getGitBranchMock(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

const TARGET = "t1";

function snapshot(id: string, lines: string[]) {
  return { id, lines, lastInputTime: 0, lastOutputTime: 0, lastCheckTime: 0, spawnedAt: 0 };
}

// Only the target terminal exists; a read of every terminal fails the test.
function makePtyClient(
  lines: string[] = [],
  terminal: { cwd: string; worktreeId?: string } = { cwd: "/repo/worktrees/feature" }
) {
  return {
    getTerminalSnapshot: vi.fn(async (id: string) => (id === TARGET ? snapshot(id, lines) : null)),
    getTerminalAsync: vi.fn(async (id: string) => (id === TARGET ? { id, ...terminal } : null)),
    getAllTerminalSnapshots: vi.fn(async () => {
      throw new Error("read every terminal");
    }),
  };
}

function asPtyClient(client: ReturnType<typeof makePtyClient>): PtyClient {
  return client as unknown as PtyClient;
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

  it("never turns a credential, its name or an opaque ID into a term", () => {
    // Bodies are assembled at runtime so no credential literal sits in source.
    const githubToken = `ghp_${"aB3xK9mQ".repeat(4)}Zt7W`;
    const openaiKey = `sk-proj-${"Qw8eRt2Y".repeat(3)}-UserProfileCache-${"Lm4nB6vC".repeat(3)}`;
    const ids = extractTerminalIdentifiers([
      `export OPENAI_API_KEY=${openaiKey}`,
      `remote: https://x-access-token:${githubToken}@github.com/owner/repo-name`,
      "the rest of a wrapped key: AbcDefGhi",
      "request_id=e29b-41d4-a716-446655440000 handled by useSessionRouter",
    ]);
    expect(ids).toContain("useSessionRouter");
    expect(ids).not.toContain("AbcDefGhi");
    for (const id of ids) {
      expect(githubToken).not.toContain(id);
      expect(openaiKey).not.toContain(id);
    }
    expect(ids).not.toContain("OPENAI_API_KEY");
    expect(ids.some((id) => id.includes("a716"))).toBe(false);
  });

  it("rejoins a credential an OSC sequence split, and drops OSC payloads", () => {
    const token = `ghp_${"aB3xK9mQ".repeat(2)}\u001b]0;tab title\u0007${"Zt7WpL2n".repeat(2)}`;
    const ids = extractTerminalIdentifiers([
      `using ${token} now`,
      "",
      "\u001b]8;;https://example.com/window-title-text\u0007useSessionRouter\u001b]8;;\u0007",
    ]);
    expect(ids).toEqual(["useSessionRouter"]);
  });

  it.each([
    ["ESC ] … BEL", "\u001b]0;windowTitle\u0007"],
    ["ESC ] … ESC \\", "\u001b]0;windowTitle\u001b\\"],
    ["8-bit OSC … BEL", "\u009d0;windowTitle\u0007"],
    ["ESC ] … 8-bit ST", "\u001b]0;windowTitle\u009c"],
  ])("removes an OSC sequence (%s) whole, rejoining the text around it", (_form, osc) => {
    expect(extractTerminalIdentifiers([`use${osc}SessionRouter`])).toEqual(["useSessionRouter"]);
  });

  it("drops long branch slugs but keeps short compound identifiers", () => {
    const ids = extractTerminalIdentifiers([
      "Switched to bugfix-issue-14621-terminal-derived-keyterms-can-send",
      "edited voice-context-keyterms",
    ]);
    expect(ids).toContain("voice-context-keyterms");
    expect(ids.some((id) => id.startsWith("bugfix-issue"))).toBe(false);
  });
});

describe("assembleKeyterms", () => {
  it("preserves custom dictionary with highest priority, newest first", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["Daintree", "Whisper", "xterm"],
    });
    expect(result.slice(0, 3)).toEqual(["xterm", "Whisper", "Daintree"]);
  });

  it("drops the oldest dictionary terms first when the dictionary overflows", async () => {
    const dictionary = Array.from({ length: 100 }, (_, i) => `customTerm${i}`);
    const result = await assembleKeyterms({ customDictionary: dictionary });
    expect(result).toHaveLength(MAX_DICTIONARY_KEYTERMS);
    expect(result[0]).toBe("customTerm99");
    expect(result).toContain(`customTerm${100 - MAX_DICTIONARY_KEYTERMS}`);
    expect(result).not.toContain(`customTerm${99 - MAX_DICTIONARY_KEYTERMS}`);
  });

  it("puts the project's vocabulary ahead of the global dictionary, each newest first", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["Whisper", "xterm"],
      projectDictionary: ["Daintree", "PtyClient"],
    });
    expect(result.slice(0, 4)).toEqual(["PtyClient", "Daintree", "xterm", "Whisper"]);
  });

  it("spends the shared dictionary budget on project terms before global ones", async () => {
    const project = Array.from({ length: MAX_DICTIONARY_KEYTERMS - 2 }, (_, i) => `projTerm${i}`);
    const global = Array.from({ length: 10 }, (_, i) => `globalTerm${i}`);
    const result = await assembleKeyterms({
      customDictionary: global,
      projectDictionary: project,
    });
    expect(result).toHaveLength(MAX_DICTIONARY_KEYTERMS);
    expect(result.filter((t) => t.startsWith("projTerm"))).toHaveLength(project.length);
    expect(result.filter((t) => t.startsWith("globalTerm"))).toEqual([
      "globalTerm9",
      "globalTerm8",
    ]);
  });

  it("sends a term in both lists once, in the project's casing", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["daintree"],
      projectDictionary: ["Daintree"],
    });
    expect(result).toEqual(["Daintree"]);
  });

  it("bounds project tokens so branch tokens still get reserved slots", async () => {
    const dictionary = Array.from({ length: 100 }, (_, i) => `customTerm${i}`);
    const result = await assembleKeyterms({
      customDictionary: dictionary,
      projectName: "Alpha Bravo Charlie Delta Echo Foxtrot Gamma Hotel",
      terminalId: TARGET,
      ptyClient: asPtyClient(
        makePtyClient([], { cwd: "/repo", worktreeId: "/repo/worktrees/feature" })
      ),
    });
    expect(result).toContain("service");
    expect(result.length).toBeLessThanOrEqual(MAX_KEYTERMS);
  });

  it("keeps slots for project and branch tokens however large the dictionary", async () => {
    const dictionary = Array.from({ length: 100 }, (_, i) => `customTerm${i}`);
    const result = await assembleKeyterms({
      customDictionary: dictionary,
      projectName: "Daintree Forest",
    });
    expect(result).toContain("Daintree Forest");
    expect(result).toContain("Daintree");
    expect(result).toContain("Forest");
    expect(result.length).toBeLessThanOrEqual(MAX_KEYTERMS);
  });

  describe("command terms", () => {
    const commands = Array.from({ length: 20 }, (_, i) => `command name ${i}`);

    it("never displaces a dictionary term", async () => {
      const dictionary = Array.from({ length: 100 }, (_, i) => `customTerm${i}`);
      const result = await assembleKeyterms({
        customDictionary: dictionary,
        commandTerms: Promise.resolve(commands),
      });
      const fromDictionary = result.filter((term) => term.startsWith("customTerm"));
      expect(fromDictionary).toHaveLength(MAX_DICTIONARY_KEYTERMS);
      expect(result.length).toBeLessThanOrEqual(MAX_KEYTERMS);
    });

    it("fits every tier at its cap beside a full dictionary, branch included", async () => {
      const dependencies = ["brindlewood", "corvaxjs", "drumlinkit", "elmwort", "fennickdb"];
      const root = await mkdtemp(join(tmpdir(), "voice-budget-"));
      try {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "quartzline",
            dependencies: Object.fromEntries([...dependencies, "gorselyui"].map((d) => [d, "1"])),
          })
        );
        const dictionary = Array.from({ length: 100 }, (_, i) => `customTerm${i}`);
        const names = {
          hosts: Array.from({ length: 5 }, (_, i) => `Mac Studio ${i + 1}`),
          projects: Array.from({ length: 5 }, (_, i) => `Plugin Kit ${i + 1}`),
          worktrees: ["billing", "checkout", "ledger"],
        };
        const result = await assembleKeyterms({
          customDictionary: dictionary,
          projectName: "Alpha Bravo Charlie Delta Echo",
          projectPath: root,
          terminalId: TARGET,
          ptyClient: asPtyClient(
            makePtyClient(["const userSessionStore = createStore();"], {
              cwd: "/repo",
              worktreeId: "/repo/worktrees/feature",
            })
          ),
          names,
          commandTerms: Promise.resolve(commands),
        });
        // 36 dictionary + 4 project + 6 repository + 12 names + 12 command + 4 branch.
        expect(result.filter((t) => t.startsWith("customTerm"))).toHaveLength(
          MAX_DICTIONARY_KEYTERMS
        );
        expect(result).toEqual(
          expect.arrayContaining(["Alpha Bravo Charlie Delta Echo", "Alpha", "Bravo", "Charlie"])
        );
        expect(result).toEqual(expect.arrayContaining(["quartzline", ...dependencies]));
        const screened = screenDictationNames(names);
        const sentNames = [...screened.hosts, ...screened.projects, ...screened.worktrees];
        expect(sentNames).toHaveLength(MAX_NAME_KEYTERMS);
        expect(result).toEqual(expect.arrayContaining(sentNames));
        expect(result.filter((t) => t.startsWith("command name"))).toHaveLength(12);
        expect(result.slice(-4)).toEqual(["feature", "auth", "login", "service"]);
        expect(result).toHaveLength(MAX_KEYTERMS);
        // The terminal tier takes only what is left.
        expect(result).not.toContain("userSessionStore");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("adds commands most likely first, ahead of terminal identifiers", async () => {
      const ptyClient = makePtyClient(["const userSessionStore = createStore();"]);
      const result = await assembleKeyterms({
        customDictionary: [],
        terminalId: TARGET,
        ptyClient: asPtyClient(ptyClient),
        commandTerms: Promise.resolve(["plugin creator", "review"]),
      });
      const pluginAt = result.indexOf("plugin creator");
      expect(pluginAt).toBeGreaterThanOrEqual(0);
      expect(result.indexOf("review")).toBe(pluginAt + 1);
      expect(result.indexOf("userSessionStore")).toBeGreaterThan(pluginAt);
    });

    it("caps the tier and skips names too short to help", async () => {
      const result = await assembleKeyterms({
        customDictionary: [],
        commandTerms: Promise.resolve(["ui", ...commands]),
      });
      expect(result).not.toContain("ui");
      expect(result.filter((term) => term.startsWith("command name")).length).toBeLessThan(
        commands.length
      );
    });

    it("starts without commands when their lookup fails", async () => {
      const result = await assembleKeyterms({
        customDictionary: ["Daintree"],
        commandTerms: Promise.reject(new Error("lookup failed")),
      });
      expect(result).toEqual(["Daintree"]);
    });
  });

  it("adds project name tokens", async () => {
    const result = await assembleKeyterms({
      customDictionary: [],
      projectName: "DaintreeEditor",
    });
    expect(result).toContain("DaintreeEditor");
  });

  it("adds branch tokens from the worktree the target terminal is filed under", async () => {
    const ptyClient = makePtyClient([], { cwd: "/repo", worktreeId: "/repo/worktrees/feature" });
    const result = await assembleKeyterms({
      customDictionary: [],
      terminalId: TARGET,
      ptyClient: asPtyClient(ptyClient),
    });
    expect(getGitBranchMock).toHaveBeenCalledWith("/repo/worktrees/feature", expect.anything());
    // From mock: "feature/auth-login-service"
    expect(result).toContain("auth");
    expect(result).toContain("login");
    expect(result).toContain("service");
  });

  it("reads the branch from the terminal's cwd when it isn't in a worktree", async () => {
    getGitBranchMock.mockClear();
    await assembleKeyterms({
      customDictionary: [],
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient([], { cwd: "/home/me/scratch" })),
    });
    expect(getGitBranchMock).toHaveBeenCalledWith("/home/me/scratch", expect.anything());
  });

  it("adds terminal identifiers from the target terminal", async () => {
    const ptyClient = makePtyClient(["const myVariable = handleRequest();"]);
    const result = await assembleKeyterms({
      customDictionary: [],
      terminalId: TARGET,
      ptyClient: asPtyClient(ptyClient),
    });
    expect(result).toContain("myVariable");
    expect(result).toContain("handleRequest");
    expect(ptyClient.getTerminalSnapshot).toHaveBeenCalledWith(TARGET);
    expect(ptyClient.getAllTerminalSnapshots).not.toHaveBeenCalled();
  });

  it("reads the terminal it is given, not another one", async () => {
    getGitBranchMock.mockClear();
    const terminals: Record<string, { lines: string[]; cwd: string; worktreeId: string }> = {
      t1: { lines: ["useFirstTerminal"], cwd: "/a", worktreeId: "/repo/worktrees/first" },
      t2: { lines: ["useSecondTerminal"], cwd: "/b", worktreeId: "/repo/worktrees/second" },
    };
    const ptyClient = {
      getTerminalSnapshot: vi.fn(async (id: string) =>
        terminals[id] ? snapshot(id, terminals[id].lines) : null
      ),
      getTerminalAsync: vi.fn(async (id: string) =>
        terminals[id] ? { id, ...terminals[id] } : null
      ),
    } as unknown as PtyClient;
    const result = await assembleKeyterms({ customDictionary: [], terminalId: "t2", ptyClient });
    expect(result).toContain("useSecondTerminal");
    expect(result).not.toContain("useFirstTerminal");
    expect(getGitBranchMock).toHaveBeenCalledWith("/repo/worktrees/second", expect.anything());
  });

  it("gives up on a terminal read that never answers", async () => {
    vi.useFakeTimers();
    try {
      const ptyClient = {
        getTerminalSnapshot: vi.fn(() => new Promise(() => {})),
        getTerminalAsync: vi.fn(() => new Promise(() => {})),
      } as unknown as PtyClient;
      const pending = assembleKeyterms({
        customDictionary: ["CustomFirst"],
        terminalId: TARGET,
        ptyClient,
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual(["CustomFirst"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads no terminal and no branch without a target", async () => {
    getGitBranchMock.mockClear();
    const ptyClient = makePtyClient(["const myVariable = handleRequest();"]);
    const result = await assembleKeyterms({
      customDictionary: ["CustomFirst"],
      ptyClient: asPtyClient(ptyClient),
    });
    expect(result).toEqual(["CustomFirst"]);
    expect(ptyClient.getTerminalSnapshot).not.toHaveBeenCalled();
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(ptyClient.getAllTerminalSnapshots).not.toHaveBeenCalled();
    expect(getGitBranchMock).not.toHaveBeenCalled();
  });

  it("skips a project or branch name holding a credential before splitting it", async () => {
    const token = `ghp_${"aB3xK9mQ".repeat(4)}Zt7W`;
    getGitBranchMock.mockResolvedValueOnce(`fix/${token}-ProfileCache/login-flow`);
    const result = await assembleKeyterms({
      customDictionary: [],
      projectName: `${token}-ProjectCache`,
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient()),
    });
    expect(result).toContain("login");
    expect(result).not.toContain("ProfileCache");
    expect(result.some((term) => term.includes("Project"))).toBe(false);
  });

  it("drops credential names and IDs from project and branch names, piece by piece", async () => {
    getGitBranchMock.mockResolvedValueOnce("fix/550e8400-e29b-41d4-a716-446655440000/login-flow");
    const result = await assembleKeyterms({
      customDictionary: [],
      projectName: "Acme getAccessToken",
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient()),
    });
    expect(result).toContain("Acme");
    expect(result).toContain("login");
    expect(result).not.toContain("Token");
    expect(result).not.toContain("Acme getAccessToken");
    for (const piece of ["e29b", "41d4", "a716"]) expect(result).not.toContain(piece);
  });

  it("skips a project name holding an ID, rather than splitting the ID into pieces", async () => {
    const result = await assembleKeyterms({
      customDictionary: [],
      projectName: "Acme 550e8400-e29b-41d4-a716-446655440000",
    });
    for (const piece of ["e29b", "41d4", "a716"]) expect(result).not.toContain(piece);
  });

  it("keeps the user's own dictionary entries unfiltered", async () => {
    const result = await assembleKeyterms({ customDictionary: ["OPENAI_API_KEY"] });
    expect(result).toEqual(["OPENAI_API_KEY"]);
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
    // Each line carries one unique identifier so frequency is constant (1 line
    // each) and recency — the line position — is the sole ranking signal. The
    // oldest 40 lines fall outside the 200-line tail window; within the window,
    // the terminal-tier cap keeps only the most recent identifiers.
    const lines = Array.from({ length: 240 }, (_, i) => `term_ident_${i}`);
    // Repeated across the oldest lines, this would outrank everything if the
    // window didn't cut it off.
    for (let i = 0; i < 40; i++) lines[i] += " stale_sentinel";
    const result = await assembleKeyterms({
      customDictionary: [],
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient(lines)),
    });
    // Identifiers from the first 40 lines are dropped by the tail slice.
    expect(result).not.toContain("stale_sentinel");
    expect(result).not.toContain("term_ident_0");
    expect(result).not.toContain("term_ident_39");
    // The very newest identifier survives and the oldest windowed one (line 40,
    // lowest recency) is squeezed out by the terminal-tier cap.
    expect(result).toContain("term_ident_239");
    expect(result).not.toContain("term_ident_40");
    // Recency ranking: a more recent identifier outranks a less recent one.
    expect(result.indexOf("term_ident_239")).toBeLessThan(result.indexOf("term_ident_220"));
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
    const result = await assembleKeyterms({
      customDictionary: dictTerms,
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient(lines)),
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
    const result = await assembleKeyterms({
      customDictionary: ["terminal_ident_59"],
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient(lines)),
    });
    // Recency ranks 59→0; 59 is the dict dup. The tier should still fill with
    // the next-newest unique terms down to terminal_ident_29 (30 unique slots).
    expect(result).toContain("terminal_ident_29");
    expect(result).not.toContain("terminal_ident_28");
  });

  it("falls back gracefully when ptyClient fails", async () => {
    const ptyClient = {
      getTerminalSnapshot: vi.fn().mockRejectedValue(new Error("pty error")),
      getTerminalAsync: vi.fn().mockRejectedValue(new Error("pty error")),
    } as unknown as PtyClient;
    const result = await assembleKeyterms({
      customDictionary: ["MyTerm"],
      terminalId: TARGET,
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
    getGitBranchMock.mockRejectedValueOnce(new Error("git not found"));
    const result = await assembleKeyterms({
      customDictionary: ["CustomFirst"],
      projectName: "ProjectSecond",
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient(["const terminalIdent = true;"])),
    });
    expect(result).toContain("CustomFirst");
    expect(result).toContain("terminalIdent");
    expect(result).not.toContain("auth"); // branch tokens absent on failure
    expect(result.indexOf("CustomFirst")).toBeLessThan(result.indexOf("terminalIdent"));
  });

  it("preserves priority order: custom dict > project name > branch > terminal", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["CustomFirst"],
      projectName: "ProjectSecond",
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient(["const terminalIdent = true;"])),
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

describe("assembleKeyterms names", () => {
  const assistantNames = {
    hosts: ["Studio 1", "Studio 2"],
    projects: ["Plugin SDK"],
    worktrees: ["billing"],
  };

  it("sends host, project and worktree names whole, as spelled", async () => {
    const result = await assembleKeyterms({ customDictionary: [], names: assistantNames });
    expect(result).toEqual(["Studio 1", "Studio 2", "Plugin SDK", "billing"]);
  });

  it("puts names after the project name and before the branch", async () => {
    const result = await assembleKeyterms({
      customDictionary: [],
      projectName: "Quartzline",
      names: { hosts: [], projects: [], worktrees: ["billing"] },
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient()),
    });
    expect(result.indexOf("billing")).toBeGreaterThan(result.indexOf("Quartzline"));
    expect(result.indexOf("billing")).toBeLessThan(result.indexOf("auth"));
  });

  it("keeps every dictionary term when names are present", async () => {
    const dictionary = Array.from({ length: 80 }, (_, i) => `customTerm${i}`);
    const result = await assembleKeyterms({ customDictionary: dictionary, names: assistantNames });
    for (let i = 79; i > 79 - MAX_DICTIONARY_KEYTERMS; i--) {
      expect(result).toContain(`customTerm${i}`);
    }
    expect(result).toContain("Studio 1");
    expect(result.length).toBeLessThanOrEqual(MAX_KEYTERMS);
  });

  it("keeps every name, command and four branch words when every tier ahead is full", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-tiers-"));
    try {
      const deps = ["zephyr", "quasar", "nebula", "photon", "tachyon", "neutrino", "graviton"];
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "meridian",
          dependencies: Object.fromEntries(deps.map((d) => [d, "1"])),
        })
      );
      const branch = "feature/alpha-bravo-charlie-delta-hotel-india-juliet-kilo";
      getGitBranchMock.mockResolvedValueOnce(branch);
      const names = {
        hosts: Array.from({ length: 6 }, (_, i) => `Mac Studio ${i + 1}`),
        projects: Array.from({ length: 6 }, (_, i) => `Plugin Kit ${i + 1}`),
        worktrees: ["billing", "checkout", "ledger", "invoices", "payouts"],
      };
      const dictionary = Array.from({ length: 80 }, (_, i) => `customTerm${i}`);
      const commands = Array.from({ length: 20 }, (_, i) => `command name ${i}`);

      const result = await assembleKeyterms({
        customDictionary: dictionary,
        projectName: "QuartzlineOrbitStudio",
        projectPath: root,
        names,
        commandTerms: Promise.resolve(commands),
        terminalId: TARGET,
        ptyClient: asPtyClient(makePtyClient(["const handleRequest = useSessionStore();"])),
      });

      const screened = screenDictationNames(names);
      const sentNames = [...screened.hosts, ...screened.projects, ...screened.worktrees];
      const count = (terms: string[]) => terms.filter((t) => result.includes(t)).length;
      expect(result).toHaveLength(MAX_KEYTERMS);
      expect(count(dictionary)).toBe(MAX_DICTIONARY_KEYTERMS);
      expect(count(["QuartzlineOrbitStudio", "Quartzline", "Orbit", "Studio"])).toBe(4);
      expect(count(["meridian", ...deps])).toBe(6);
      expect(sentNames).toHaveLength(MAX_NAME_KEYTERMS);
      expect(count(sentNames)).toBe(MAX_NAME_KEYTERMS);
      expect(count(commands)).toBe(12);
      expect(count(tokenizeBranchName(branch))).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops secret-shaped names", async () => {
    const result = await assembleKeyterms({
      customDictionary: [],
      names: { hosts: ["sk-abcdefghijklmnopqrstuvwxyz0123456789"], projects: [], worktrees: [] },
    });
    expect(result).toEqual([]);
  });

  it("reads names alongside the terminal, not before it", async () => {
    vi.useFakeTimers();
    try {
      const after400ms = <T>(value: T) =>
        new Promise<T>((resolve) => setTimeout(() => resolve(value), 400));
      const client = makePtyClient();
      client.getTerminalSnapshot.mockImplementation((id: string) =>
        after400ms(snapshot(id, ["const handleRequest = useSessionStore();"]))
      );
      let result: string[] | undefined;
      void assembleKeyterms({
        customDictionary: [],
        names: after400ms(assistantNames),
        terminalId: TARGET,
        ptyClient: asPtyClient(client),
      }).then((terms) => (result = terms));

      // Both 400ms reads land within one budget: waited one after the other,
      // they would take 800ms.
      await vi.advanceTimersByTimeAsync(450);
      expect(result).toContain("Studio 1");
      expect(result).toContain("useSessionStore");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts without names that miss the budget", async () => {
    vi.useFakeTimers();
    try {
      const client = makePtyClient(["const handleRequest = useSessionStore();"]);
      const pending = assembleKeyterms({
        customDictionary: [],
        names: new Promise(() => {}),
        terminalId: TARGET,
        ptyClient: asPtyClient(client),
      });
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;
      expect(result).toContain("useSessionStore");
      expect(result).not.toContain("Studio 1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts without names when reading them fails", async () => {
    const result = await assembleKeyterms({
      customDictionary: ["CustomFirst"],
      names: Promise.reject(new Error("registry gone")),
    });
    expect(result).toEqual(["CustomFirst"]);
  });
});

describe("screenDictationNames", () => {
  const none = { hosts: [], projects: [], worktrees: [] };

  it("trims names and drops ones too short or all digits to be spoken", () => {
    expect(
      screenDictationNames({ ...none, hosts: ["  Studio 1  ", "x", "", "   ", "2024"] })
    ).toEqual({ ...none, hosts: ["Studio 1"] });
  });

  it("drops credential- and secret-shaped names from every kind", () => {
    const screened = screenDictationNames({
      hosts: ["sk-abcdefghijklmnopqrstuvwxyz0123456789"],
      projects: ["GITHUB_TOKEN"],
      worktrees: [`ghp_${"a1B2".repeat(9)}`, "billing"],
    });
    expect(screened).toEqual({ hosts: [], projects: [], worktrees: ["billing"] });
  });

  it("keeps the first spelling of a name that recurs in any case", () => {
    expect(
      screenDictationNames({ hosts: ["Studio"], projects: ["studio", "Plugin SDK"], worktrees: [] })
    ).toEqual({ hosts: ["Studio"], projects: ["Plugin SDK"], worktrees: [] });
  });

  it("takes five of each kind and twelve in all, keeping four for the worktrees", () => {
    const many = (prefix: string) => Array.from({ length: 8 }, (_, i) => `${prefix} ${i + 1}`);
    const screened = screenDictationNames({
      hosts: many("host"),
      projects: many("project"),
      worktrees: many("worktree"),
    });
    expect(screened.hosts).toEqual(many("host").slice(0, 5));
    expect(screened.projects).toEqual(many("project").slice(0, 3));
    expect(screened.worktrees).toEqual(many("worktree").slice(0, 4));
    expect(screened.hosts.length + screened.projects.length + screened.worktrees.length).toBe(
      MAX_NAME_KEYTERMS
    );
  });

  it("keeps only the worktrees there are when hosts and projects fill what is left", () => {
    const many = (prefix: string) => Array.from({ length: 8 }, (_, i) => `${prefix} ${i + 1}`);
    const screened = screenDictationNames({
      hosts: many("host"),
      projects: many("project"),
      worktrees: ["billing"],
    });
    expect(screened.hosts).toEqual(many("host").slice(0, 5));
    expect(screened.projects).toEqual(many("project").slice(0, 5));
    expect(screened.worktrees).toEqual(["billing"]);
  });

  it("doesn't let a screened-out name use up a slot", () => {
    const screened = screenDictationNames({
      ...none,
      worktrees: ["GITHUB_TOKEN", "1", "a", "one", "two", "three", "four", "five"],
    });
    expect(screened.worktrees).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("caps each name at the per-term length without splitting a surrogate pair", () => {
    const long = `${"a".repeat(99)}😀tail`;
    const [capped] = screenDictationNames({ ...none, hosts: [long] }).hosts;
    expect(capped).toBe("a".repeat(99));
  });

  it("skips entries that aren't strings", () => {
    const names = { ...none, hosts: [42, null, "Studio 1"] as unknown as string[] };
    expect(screenDictationNames(names).hosts).toEqual(["Studio 1"]);
  });
});

describe("screenCorrectionRepositoryNames", () => {
  it("keeps names whole, scope dropped, in the order they were derived, each spelling once", () => {
    expect(
      screenCorrectionRepositoryNames([
        "daintree",
        "@daintree/plugin-sdk",
        "electron",
        "Plugin-SDK",
        "simple-git",
        "@xterm/xterm",
      ])
    ).toEqual(["daintree", "plugin-sdk", "electron", "simple-git", "xterm"]);
  });

  it("drops credential-shaped names, and ones the quoted list can't carry", () => {
    expect(
      screenCorrectionRepositoryNames([
        `ghp_${"a1B2".repeat(9)}`,
        "GITHUB_TOKEN",
        'say "hi"',
        "a|b",
        "line\nbreak",
        "<script>",
        "x",
        "2024",
        "a".repeat(61),
        42,
        "react",
      ])
    ).toEqual(["react"]);
  });

  it("screens a name before dropping its scope, so a key in the scope takes the name with it", () => {
    expect(screenCorrectionRepositoryNames([`@ghp_${"a1B2".repeat(9)}/tools`, "react"])).toEqual([
      "react",
    ]);
  });

  it("stops at sixty, so the dependencies at the tail are what a long list loses", () => {
    const names = Array.from({ length: 70 }, (_, i) => `package-${i + 1}`);
    const screened = screenCorrectionRepositoryNames(names);
    expect(screened).toHaveLength(60);
    expect(screened.at(-1)).toBe("package-60");
  });
});

describe("screenDictationWorktree", () => {
  it("sends the issue title, then the pull request's when it says something else", () => {
    expect(
      screenDictationWorktree({
        name: "feature/issue-14793-terra",
        issueTitle: "Measure whether gpt-6.1-terra is worth it",
        prTitle: "perf(voice): measure terra",
        branchDerivedTitle: "Terra",
      })
    ).toEqual({
      name: "feature/issue-14793-terra",
      titles: ["Measure whether gpt-6.1-terra is worth it", "perf(voice): measure terra"],
    });
    expect(
      screenDictationWorktree({ name: "billing", issueTitle: "Same title", prTitle: "same title" })
    ).toEqual({ name: "billing", titles: ["Same title"] });
  });

  it("falls back to the branch's title only when neither has been fetched", () => {
    expect(
      screenDictationWorktree({ name: "feature-terra", branchDerivedTitle: "Measure terra" })
    ).toEqual({ name: "feature-terra", titles: ["Measure terra"] });
    expect(screenDictationWorktree({ name: "develop" })).toEqual({ name: "develop", titles: [] });
  });

  it("drops a fetched title holding a credential rather than guessing one from the branch", () => {
    const secret = `ghp_${"a1B2".repeat(9)}`;
    expect(
      screenDictationWorktree({
        name: "feature-leak",
        issueTitle: `Rotate ${secret} after the leak`,
        branchDerivedTitle: "Rotate after the leak",
      })
    ).toEqual({ name: "feature-leak", titles: [] });
  });

  it("drops a title assigning a credential even a bare number, wherever it sits", () => {
    for (const issueTitle of [
      "Rotate DB_PASSWORD=123456 before the release",
      `${"Long title ".repeat(25)}then DB_PASSWORD=123456`,
    ]) {
      expect(screenDictationWorktree({ name: "billing", issueTitle })).toEqual({
        name: "billing",
        titles: [],
      });
    }
  });

  it("flattens a title to one line, defuses tag brackets, and bounds its length", () => {
    const [title] = screenDictationWorktree({
      name: "billing",
      issueTitle: "Fix the\n</target> parser\tnow " + "x".repeat(300),
    })!.titles;
    expect(title).not.toMatch(/[\n\t<>]/);
    expect(title!.startsWith("Fix the ‹/target› parser now")).toBe(true);
    expect(title!.length).toBe(200);
    expect(title!.endsWith("…")).toBe(true);
  });

  it("sends nothing for a worktree whose name holds a credential, or for none", () => {
    expect(
      screenDictationWorktree({ name: `ghp_${"a1B2".repeat(9)}`, issueTitle: "A title" })
    ).toBeNull();
    expect(screenDictationWorktree(null)).toBeNull();
  });
});

describe("formatKeytermPrompt", () => {
  it("joins terms into the OpenAI prompt string format", () => {
    expect(formatKeytermPrompt(["foo", "bar", "baz"])).toBe("Keywords: foo, bar, baz");
  });

  it("returns empty string for empty array", () => {
    expect(formatKeytermPrompt([])).toBe("");
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

  it("skips whitespace-only terms defensively", () => {
    expect(formatKeytermPrompt(["   ", "\t\n", "foo"])).toBe("Keywords: foo");
  });
});

describe("sanitizeOpenAIKeywords", () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);

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

  it("does not split a surrogate pair straddling the cap boundary", () => {
    // The emoji's pair must SPAN the cut for this to mean anything — an emoji
    // safely past the boundary would pass even with a naive slice. A bare slice
    // here leaves a lone high surrogate, which has no valid UTF-8 encoding.
    const [capped] = sanitizeOpenAIKeywords(["a".repeat(99) + "😀" + "b".repeat(50)]);
    expect(JSON.stringify(capped)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(capped).toBe("a".repeat(99));
  });

  it("drops a term that already contains an unpaired surrogate", () => {
    // Corrupted input (truncated mid-emoji upstream, or a mangled terminal
    // read) is unsendable, so it's dropped like any other bad term — not
    // repaired into a different word.
    const loneHigh = String.fromCharCode(0xd83d);
    const loneLow = String.fromCharCode(0xde00);
    expect(sanitizeOpenAIKeywords([`bad${loneHigh}`, `bad${loneLow}`, "Daintree"])).toEqual([
      "Daintree",
    ]);
  });

  it("keeps a well-formed emoji term intact", () => {
    expect(sanitizeOpenAIKeywords(["ship 🚀"])).toEqual(["ship 🚀"]);
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

  it("trims a trailing newline rather than rejecting the term", () => {
    // Trimming yields the same term the user meant; only an INTERNAL CR/LF
    // (a multi-line blob) is grounds for dropping it.
    expect(sanitizeOpenAIKeywords([`Daintree${LF}`, `xterm${CR}`])).toEqual(["Daintree", "xterm"]);
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
});

describe("assembleTaggedKeyterms", () => {
  it("tags each term with the tier that won it and matches assembleKeyterms", async () => {
    const opts = {
      customDictionary: ["zodSchema", "Daintree"],
      projectName: "Daintree Desktop",
    };
    const tagged = await assembleTaggedKeyterms(opts);
    expect(tagged.map((t) => t.term)).toEqual(await assembleKeyterms(opts));
    // Newest dictionary entry first; "Daintree" belongs to the dictionary, so
    // the project tier's duplicate doesn't take it over.
    expect(tagged.find((t) => t.term === "Daintree")?.source).toBe("dictionary");
    expect(tagged.find((t) => t.term === "Desktop")?.source).toBe("project");
  });

  it("tags host, project and worktree names as names, between the project and the branch", async () => {
    const opts = {
      customDictionary: ["zodSchema"],
      projectName: "Quartzline",
      names: Promise.resolve({
        hosts: ["Studio 1"],
        projects: ["Plugin SDK"],
        worktrees: ["billing"],
      }),
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient()),
    };
    const tagged = await assembleTaggedKeyterms(opts);
    expect(tagged.map((t) => t.term)).toEqual(await assembleKeyterms(opts));
    const sources = tagged.map((t) => t.source);
    expect(tagged.filter((t) => t.source === "names").map((t) => t.term)).toEqual([
      "Studio 1",
      "Plugin SDK",
      "billing",
    ]);
    expect(sources.indexOf("names")).toBeGreaterThan(sources.lastIndexOf("project"));
    expect(sources.lastIndexOf("names")).toBeLessThan(sources.indexOf("branch"));
  });

  it("tags the target's commands as commands, after the names and ahead of the branch", async () => {
    const opts = {
      customDictionary: ["zodSchema"],
      names: Promise.resolve({ hosts: ["Studio 1"], projects: [], worktrees: [] }),
      commandTerms: Promise.resolve(["plugin creator", "review"]),
      terminalId: TARGET,
      ptyClient: asPtyClient(makePtyClient()),
    };
    const tagged = await assembleTaggedKeyterms(opts);
    expect(tagged.map((t) => t.term)).toEqual(await assembleKeyterms(opts));
    const sources = tagged.map((t) => t.source);
    expect(tagged.filter((t) => t.source === "commands").map((t) => t.term)).toEqual([
      "plugin creator",
      "review",
    ]);
    expect(sources.indexOf("commands")).toBeGreaterThan(sources.lastIndexOf("names"));
    expect(sources.lastIndexOf("commands")).toBeLessThan(sources.indexOf("branch"));
  });

  it("screens names in the tagged list the same way", async () => {
    const tagged = await assembleTaggedKeyterms({
      customDictionary: [],
      names: {
        hosts: [" Studio 1 ", "sk-abcdefghijklmnopqrstuvwxyz0123456789", "7"],
        projects: [],
        worktrees: [],
      },
    });
    expect(tagged).toEqual([{ term: "Studio 1", source: "names" }]);
  });

  it("tags the project's own dictionary apart from the user's", async () => {
    const tagged = await assembleTaggedKeyterms({
      customDictionary: ["mine"],
      projectDictionary: ["shared"],
    });
    expect(tagged).toEqual(
      expect.arrayContaining([
        { term: "shared", source: "projectDictionary" },
        { term: "mine", source: "dictionary" },
      ])
    );
  });

  it("tags branch and terminal terms from the target terminal", async () => {
    const ptyClient = makePtyClient(["const myVariable = handleRequest();"]);
    const tagged = await assembleTaggedKeyterms({
      customDictionary: ["zodSchema"],
      terminalId: TARGET,
      ptyClient: asPtyClient(ptyClient),
    });
    const bySource = (source: string) =>
      tagged.filter((t) => t.source === source).map((t) => t.term);
    expect(bySource("dictionary")).toEqual(["zodSchema"]);
    expect(bySource("branch")).toContain("auth");
    expect(bySource("terminal")).toEqual(expect.arrayContaining(["myVariable", "handleRequest"]));
    expect(bySource("branch")).not.toContain("myVariable");
  });
});

describe("keyterms from a pane read elsewhere", () => {
  it("gives the same list from a host's reads as from reading the pane here", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "voice-pane-reads-"));
    try {
      await writeFile(
        join(projectPath, "package.json"),
        JSON.stringify({ name: "@acme/quartzline-widgets" })
      );
      const lines = ["const myVariable = handleRequest();", "myVariable"];
      const readHere = await assembleTaggedKeyterms({
        customDictionary: ["zodSchema"],
        projectPath,
        terminalId: TARGET,
        ptyClient: asPtyClient(makePtyClient(lines)),
      });
      const paneReads = await readPaneKeytermReads({
        projectPath,
        terminalId: TARGET,
        ptyClient: asPtyClient(makePtyClient(lines)),
      });
      const readElsewhere = await assembleTaggedKeyterms({
        customDictionary: ["zodSchema"],
        paneReads: Promise.resolve(paneReads),
      });
      expect(readElsewhere).toEqual(readHere);
      const bySource = (source: string) =>
        readElsewhere.filter((t) => t.source === source).map((t) => t.term);
      expect(bySource("repository")).toEqual(expect.arrayContaining(["quartzline", "widgets"]));
      expect(bySource("branch")).toContain("auth");
      expect(bySource("terminal")).toContain("myVariable");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("reads nothing here once given a pane's reads", async () => {
    const ptyClient = makePtyClient(["const myVariable = handleRequest();"]);
    const tagged = await assembleTaggedKeyterms({
      customDictionary: [],
      terminalId: TARGET,
      ptyClient: asPtyClient(ptyClient),
      paneReads: { repoNames: [], branchName: "feature/remote-voice", terminalTerms: [] },
    });
    expect(tagged.map((t) => t.term)).toEqual(["feature", "remote", "voice"]);
    expect(ptyClient.getTerminalSnapshot).not.toHaveBeenCalled();
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
  });

  it("screens a pane's terminal terms again before sending them", async () => {
    const tagged = await assembleTaggedKeyterms({
      customDictionary: [],
      paneReads: {
        repoNames: [],
        branchName: null,
        terminalTerms: ["sk-abcdefghijklmnopqrstuvwxyz0123456789", "echo", "useStore"],
      },
    });
    expect(tagged).toEqual([{ term: "useStore", source: "terminal" }]);
  });
});
