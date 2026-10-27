import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../../PtyClient.js";
import type { WorkspaceClient } from "../../WorkspaceClient.js";

const shared = vi.hoisted(() => ({
  vocabularyReads: [] as string[],
  vocabularyRead: null as null | (() => Promise<unknown>),
  commandReads: [] as Array<{ terminalId: string | undefined; timeoutMs: number }>,
  searches: [] as Array<{ cwd: string; description: string }>,
}));

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getProjectById: vi.fn((id: string) =>
      id === "proj-a"
        ? { id, name: "Daintree", path: "/repo/daintree" }
        : id === "proj-b"
          ? { id, name: "Plugin SDK", path: "/repo/sdk" }
          : null
    ),
    getProjectSummaries: vi.fn(() => []),
  },
}));

vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

vi.mock("../../../remote/runtime.js", () => ({ getRemoteService: () => undefined }));

vi.mock("../../projectVoiceDictionary.js", () => ({
  readProjectVoiceDictionary: vi.fn(async (projectId: string) => {
    shared.vocabularyReads.push(projectId);
    if (shared.vocabularyRead) return shared.vocabularyRead();
    return [{ term: `${projectId}-term`, heardAs: [], source: "manual", addedAt: 1 }];
  }),
}));

vi.mock("../../voiceCommandTarget.js", () => ({
  resolveVoiceCommandTarget: vi.fn(
    async (_pty: unknown, terminalId: string | undefined, timeoutMs: number) => {
      shared.commandReads.push({ terminalId, timeoutMs });
      return terminalId
        ? {
            agentId: "claude",
            agentName: "Claude",
            isAssistant: false,
            vocabulary: { entries: [], prefixes: [] },
          }
        : null;
    }
  ),
}));

vi.mock("../../../utils/gitUtils.js", () => ({
  getGitBranch: vi.fn(async () => "feature/voice-hosts"),
}));

vi.mock("../../voiceRepoKeyterms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../voiceRepoKeyterms.js")>()),
  deriveRepoNames: vi.fn(async () => ({ names: ["@daintree/plugin-kit"] })),
}));

vi.mock("../../FileSearchService.js", () => ({
  fileSearchService: {
    searchNaturalLanguage: vi.fn(async ({ cwd, description }) => {
      shared.searches.push({ cwd, description });
      return [`src/${description}.ts`];
    }),
  },
}));

import { getGitBranch } from "../../../utils/gitUtils.js";
import {
  answerPaneCorrection,
  answerPaneFileCandidates,
  answerPaneProject,
  answerPaneStart,
  NO_PANE_START_CONTEXT,
} from "../paneContext.js";

const OWN = "term-own";
const FOREIGN = "term-foreign";
const UNFILED = "term-unfiled";
const SECRET = `ghp_${"a1B2".repeat(9)}`;

function makePty() {
  const owners: Record<string, string | null> = {
    [OWN]: "proj-a",
    [FOREIGN]: "proj-b",
    [UNFILED]: null,
  };
  // The credential's line goes whole, and so does the line after it (a
  // wrapped key's tail): identifiers on either never leave the host.
  const lines = [
    "$ npm test -- electron/services/voice",
    `export TOKEN=${SECRET} # from useCustomerStore`,
    "useBillingStore",
    "✓ hostPaneOf reads the view key",
  ];
  return {
    hasTerminal: vi.fn((id: string) => id in owners),
    getTerminalProjectId: vi.fn((id: string) => owners[id] ?? null),
    getTerminalAsync: vi.fn(async (id: string) =>
      id in owners
        ? { id, cwd: `/worktrees/${id}`, worktreeId: `/worktrees/${id}`, kind: "terminal" }
        : null
    ),
    getTerminalSnapshot: vi.fn(async (id: string) => ({ id, lines })),
  };
}

let pty: ReturnType<typeof makePty>;
let worktreeService: { getAllStatesForProjectAsync: ReturnType<typeof vi.fn> };

function deps() {
  return {
    ptyClient: pty as unknown as PtyClient,
    worktreeService: worktreeService as unknown as WorkspaceClient,
  };
}

beforeEach(() => {
  shared.vocabularyReads = [];
  shared.vocabularyRead = null;
  shared.commandReads = [];
  shared.searches = [];
  pty = makePty();
  worktreeService = {
    getAllStatesForProjectAsync: vi.fn(async () => [
      { name: "daintree", isMainWorktree: true },
      { name: "feature-voice-hosts", isMainWorktree: false },
    ]),
  };
});

describe("a host answering for a pane in its own project", () => {
  it("reads the start context as a local pane's is read", async () => {
    const read = await answerPaneStart(deps(), { projectId: "proj-a", terminalId: OWN }, 400);
    expect(read.projectName).toBe("Daintree");
    expect(read.vocabulary.map((entry) => entry.term)).toEqual(["proj-a-term"]);
    expect(read.names.worktrees).toEqual(["feature-voice-hosts"]);
    expect(read.keyterms.branchName).toBe("feature/voice-hosts");
    expect(read.keyterms.repoNames).toEqual(["@daintree/plugin-kit"]);
    expect(read.keyterms.terminalTerms).toContain("hostPaneOf");
    expect(read.commandTarget?.agentId).toBe("claude");
    // The command lookup shares the budget the Shell sent.
    expect(shared.commandReads).toEqual([{ terminalId: OWN, timeoutMs: 400 }]);
  });

  it("screens the terminal's output before anything is sent", async () => {
    const read = await answerPaneStart(deps(), { projectId: "proj-a", terminalId: OWN }, 400);
    expect(read.keyterms.terminalTerms).toContain("hostPaneOf");
    expect(read.keyterms.terminalTerms).not.toContain("useCustomerStore");
    expect(read.keyterms.terminalTerms).not.toContain("useBillingStore");
    expect(read.keyterms.terminalTerms.join(" ")).not.toContain("a1B2");
    const correction = await answerPaneCorrection(
      deps(),
      { projectId: "proj-a", terminalId: OWN },
      1400
    );
    expect(correction.terminalOutput).toContain("hostPaneOf reads the view key");
    expect(correction.terminalOutput).not.toContain(SECRET);
  });

  it("reads the cleanup context: the view's project, its vocabulary, commands and output", async () => {
    const read = await answerPaneCorrection(deps(), { projectId: "proj-a", terminalId: OWN }, 1400);
    expect(read.project).toEqual({ name: "Daintree", path: "/repo/daintree" });
    expect(read.vocabulary.map((entry) => entry.term)).toEqual(["proj-a-term"]);
    expect(read.commandTarget?.agentName).toBe("Claude");
    expect(shared.commandReads).toEqual([{ terminalId: OWN, timeoutMs: 1400 }]);
  });

  it("searches the terminal's worktree for spoken references", async () => {
    const candidates = await answerPaneFileCandidates(
      deps(),
      { projectId: "proj-a", terminalId: OWN },
      ["voiceInput", "paneContext"],
      2000
    );
    expect(candidates).toEqual([["src/voiceInput.ts"], ["src/paneContext.ts"]]);
    expect(shared.searches.map((search) => search.cwd)).toEqual([
      `/worktrees/${OWN}`,
      `/worktrees/${OWN}`,
    ]);
  });

  it("names the project for a rewrite", () => {
    expect(answerPaneProject("proj-a")).toEqual({ name: "Daintree", path: "/repo/daintree" });
    expect(answerPaneProject("gone")).toEqual({ name: null, path: null });
  });
});

describe("nothing from another project's pane reaches the Shell", () => {
  it("reads none of a terminal another project owns", async () => {
    const read = await answerPaneStart(deps(), { projectId: "proj-a", terminalId: FOREIGN }, 400);
    expect(read).toEqual(NO_PANE_START_CONTEXT);
    expect(pty.getTerminalSnapshot).not.toHaveBeenCalled();
    expect(shared.vocabularyReads).toEqual([]);
    expect(shared.commandReads).toEqual([{ terminalId: undefined, timeoutMs: 400 }]);
  });

  it("gives cleanup no output or commands from a terminal another project owns", async () => {
    const read = await answerPaneCorrection(
      deps(),
      { projectId: "proj-a", terminalId: FOREIGN },
      1400
    );
    expect(read.terminalOutput).toBeNull();
    expect(read.commandTarget).toBeNull();
    expect(read.vocabulary).toEqual([]);
    expect(pty.getTerminalSnapshot).not.toHaveBeenCalled();
  });

  it("reads a terminal filed under no project as no terminal", async () => {
    const read = await answerPaneStart(deps(), { projectId: "proj-a", terminalId: UNFILED }, 400);
    expect(read.keyterms).toEqual(NO_PANE_START_CONTEXT.keyterms);
    expect(read.commandTarget).toBeNull();
    expect(pty.getTerminalSnapshot).not.toHaveBeenCalled();
    // The view's own vocabulary still applies, as for a panel that isn't a terminal.
    expect(shared.vocabularyReads).toEqual(["proj-a"]);
  });

  it("resolves references from another project's terminal in the view's project", async () => {
    await answerPaneFileCandidates(
      deps(),
      { projectId: "proj-a", terminalId: FOREIGN },
      ["voiceInput"],
      2000
    );
    expect(shared.searches.map((search) => search.cwd)).toEqual(["/repo/daintree"]);
  });

  it("answers nothing for a project this host doesn't have", async () => {
    const scope = { projectId: "gone", terminalId: OWN };
    await expect(answerPaneStart(deps(), scope, 400)).resolves.toEqual(NO_PANE_START_CONTEXT);
    await expect(answerPaneFileCandidates(deps(), scope, ["a", "b"], 2000)).resolves.toEqual([
      [],
      [],
    ]);
    const correction = await answerPaneCorrection(deps(), scope, 1400);
    expect(correction).toEqual({
      project: { name: null, path: null },
      vocabulary: [],
      commandTarget: null,
      terminalOutput: null,
    });
    expect(pty.hasTerminal).not.toHaveBeenCalled();
    expect(shared.searches).toEqual([]);
  });
});

describe("a host answers within the budget it was given", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with what was read in time, and none of a read that wasn't", async () => {
    shared.vocabularyRead = () => new Promise(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = answerPaneStart(deps(), { projectId: "proj-a", terminalId: OWN }, 60);
    await vi.advanceTimersByTimeAsync(60);
    const read = await answer;
    expect(read.vocabulary).toEqual([]);
    expect(read.keyterms.branchName).toBe("feature/voice-hosts");
  });

  it("keeps the terminal and repository terms when only the branch is slow", async () => {
    vi.mocked(getGitBranch).mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = answerPaneStart(deps(), { projectId: "proj-a", terminalId: OWN }, 400);
    await vi.advanceTimersByTimeAsync(400);
    const read = await answer;
    expect(read.keyterms.branchName).toBeNull();
    expect(read.keyterms.terminalTerms).toContain("hostPaneOf");
    expect(read.keyterms.repoNames).toEqual(["@daintree/plugin-kit"]);
  });

  it("gives cleanup no output past the terminal read's own bound, and the rest of its context", async () => {
    pty.getTerminalSnapshot.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answered = false;
    const answer = answerPaneCorrection(
      deps(),
      { projectId: "proj-a", terminalId: OWN },
      1400
    ).finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const read = await answer;
    expect(read.terminalOutput).toBeNull();
    expect(read.commandTarget?.agentId).toBe("claude");
    expect(read.vocabulary.map((entry) => entry.term)).toEqual(["proj-a-term"]);
  });
});
