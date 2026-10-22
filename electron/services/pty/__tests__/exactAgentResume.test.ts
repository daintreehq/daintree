import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  __resetClaudeSessionStoreForTests,
  rememberClaudePaneStore,
} from "../../claude/ClaudeSessionStore.js";
import {
  observeExactAgentResume,
  observeExactAgentResumes,
  type ExactResumeTerminal,
  type TranscriptChecker,
} from "../exactAgentResume.js";

const SESSION = "006fdfc0-67bf-4df0-ad82-48ebfe4df184";
const ROOT = "/store/projects";

function claudePane(overrides: Partial<ExactResumeTerminal> = {}): ExactResumeTerminal {
  return {
    id: "t1",
    cwd: "/work/app",
    launchAgentId: "claude",
    detectedAgentId: "claude",
    agentSessionId: SESSION,
    agentIncarnation: 0,
    hasPty: true,
    isExited: false,
    ...overrides,
  };
}

function fakeChecker(
  observation: "present" | "missing" | "unknown" | Error,
  projectsRoot: string | null = ROOT
): TranscriptChecker & { observe: ReturnType<typeof vi.fn> } {
  return {
    projectsRoot: () => projectsRoot,
    observe: vi.fn(async () => {
      if (observation instanceof Error) throw observation;
      return observation;
    }),
  };
}

describe("observeExactAgentResume", () => {
  it("answers yes for a live Claude pane whose assigned id has a transcript", async () => {
    const checker = fakeChecker("present");
    await expect(
      observeExactAgentResume(claudePane(), { checkers: { claude: checker } })
    ).resolves.toEqual({ resumesExactly: true });
    expect(checker.observe).toHaveBeenCalledWith(SESSION, "/work/app", ROOT);
  });

  it.each([
    ["missing", "no-transcript"],
    ["unknown", "transcript-unknown"],
  ] as const)("refuses a %s transcript as %s", async (observation, reason) => {
    await expect(
      observeExactAgentResume(claudePane(), { checkers: { claude: fakeChecker(observation) } })
    ).resolves.toEqual({ resumesExactly: false, reason });
  });

  it("treats a lookup that throws as unknown", async () => {
    await expect(
      observeExactAgentResume(claudePane(), {
        checkers: { claude: fakeChecker(new Error("EIO")) },
      })
    ).resolves.toEqual({ resumesExactly: false, reason: "transcript-unknown" });
  });

  it("refuses a pane whose store isn't certain without reading anything", async () => {
    const checker = fakeChecker("present", null);
    await expect(
      observeExactAgentResume(claudePane(), { checkers: { claude: checker } })
    ).resolves.toEqual({ resumesExactly: false, reason: "store-unknown" });
    expect(checker.observe).not.toHaveBeenCalled();
  });

  it("refuses an agent main has no transcript checker for", async () => {
    await expect(observeExactAgentResume(claudePane(), { checkers: {} })).resolves.toEqual({
      resumesExactly: false,
      reason: "transcript-check-unsupported",
    });
  });

  it.each([
    ["aider", "rolling-history"],
    ["amp", "named-target"],
    ["kiro", "project-scoped"],
  ] as const)("refuses %s, which resumes by %s", async (agentId, resumeKind) => {
    await expect(
      observeExactAgentResume(claudePane({ launchAgentId: agentId, detectedAgentId: agentId }))
    ).resolves.toEqual({ resumesExactly: false, reason: "resume-not-exact", resumeKind });
  });

  it("refuses a session-id agent whose id is only scraped at teardown, even holding one", async () => {
    const checker = fakeChecker("present");
    await expect(
      observeExactAgentResume(claudePane({ launchAgentId: "codex", detectedAgentId: "codex" }), {
        checkers: { codex: checker },
      })
    ).resolves.toEqual({ resumesExactly: false, reason: "id-not-assigned-at-launch" });
    expect(checker.observe).not.toHaveBeenCalled();
  });

  it("refuses a terminal that wasn't launched as an agent, or as one nobody registered", async () => {
    await expect(
      observeExactAgentResume(claudePane({ launchAgentId: undefined }))
    ).resolves.toEqual({ resumesExactly: false, reason: "no-agent" });
    await expect(
      observeExactAgentResume(claudePane({ launchAgentId: "not-an-agent" }))
    ).resolves.toEqual({ resumesExactly: false, reason: "unknown-agent" });
  });

  it("refuses a Claude pane holding no id", async () => {
    await expect(
      observeExactAgentResume(claudePane({ agentSessionId: undefined }), {
        checkers: { claude: fakeChecker("present") },
      })
    ).resolves.toEqual({ resumesExactly: false, reason: "no-session-id" });
  });

  it.each([
    ["another agent is detected", { detectedAgentId: "codex" as const }],
    ["a relaunch was observed", { agentIncarnation: 1 }],
    ["the relaunch count wasn't observed", { agentIncarnation: undefined }],
    ["the PTY isn't confirmed live", { hasPty: undefined }],
    ["the process exited", { isExited: true }],
  ])("refuses the launch id when %s", async (_label, overrides) => {
    const checker = fakeChecker("present");
    await expect(
      observeExactAgentResume(claudePane(overrides), { checkers: { claude: checker } })
    ).resolves.toEqual({ resumesExactly: false, reason: "session-identity-unknown" });
    expect(checker.observe).not.toHaveBeenCalled();
  });

  it("keeps launch affinity while nothing has been detected yet", async () => {
    await expect(
      observeExactAgentResume(claudePane({ detectedAgentId: undefined }), {
        checkers: { claude: fakeChecker("present") },
      })
    ).resolves.toEqual({ resumesExactly: true });
  });
});

describe("observeExactAgentResume against the Claude store", () => {
  let configDir: string;

  beforeEach(async () => {
    __resetClaudeSessionStoreForTests();
    configDir = await mkdtemp(path.join(os.tmpdir(), "exact-agent-resume-"));
  });

  afterEach(async () => {
    __resetClaudeSessionStoreForTests();
    await rm(configDir, { recursive: true, force: true });
  });

  it("reads the store the pane was launched against, fresh on every call", async () => {
    const projectsRoot = path.join(configDir, "projects");
    await mkdir(projectsRoot, { recursive: true });
    rememberClaudePaneStore("t1", projectsRoot);

    await expect(observeExactAgentResume(claudePane())).resolves.toEqual({
      resumesExactly: false,
      reason: "no-transcript",
    });

    const dir = path.join(projectsRoot, "-work-app");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${SESSION}.jsonl`), '{"type":"user"}\n');

    await expect(observeExactAgentResume(claudePane())).resolves.toEqual({
      resumesExactly: true,
    });
  });

  it("never falls back to a default store for a pane it didn't remember", async () => {
    await expect(observeExactAgentResume(claudePane())).resolves.toEqual({
      resumesExactly: false,
      reason: "store-unknown",
    });
  });
});

describe("observeExactAgentResumes", () => {
  it("answers every terminal in order, plain shells included", async () => {
    const checkers = { claude: fakeChecker("present") };
    await expect(
      observeExactAgentResumes(
        [
          claudePane({ id: "a" }),
          { id: "b", cwd: "/work/app", hasPty: true },
          claudePane({ id: "c", agentSessionId: undefined }),
        ],
        { checkers }
      )
    ).resolves.toEqual([
      { terminalId: "a", verdict: { resumesExactly: true } },
      { terminalId: "b", verdict: { resumesExactly: false, reason: "no-agent" } },
      { terminalId: "c", verdict: { resumesExactly: false, reason: "no-session-id" } },
    ]);
  });
});
