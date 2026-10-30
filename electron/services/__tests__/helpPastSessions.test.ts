import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  claudeProjectSlug,
  codexHelpSessionsFrom,
  listClaudeHelpSessions,
  listHelpPastSessions,
  normalizePromptTitle,
  summarizeClaudeTranscript,
} from "../helpPastSessions.js";
import {
  HELP_ASSISTANT_GREETING,
  HUB_STARTED_ASSISTANT_GREETING,
} from "../../../shared/config/helpAssistantGreeting.js";
import { HELP_PAST_SESSIONS_LIMIT } from "../../../shared/types/ipc/help.js";

const A = "006fdfc0-67bf-4df0-ad82-48ebfe4df184";
const B = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const C = "2bd2578c-b710-4302-90c1-b222c4c29aa3";

const line = (entry: unknown) => JSON.stringify(entry);
const prompt = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content }, ...extra });
const toolResult = () =>
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    toolUseResult: { stdout: "ok" },
  });
const reply = () =>
  line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
  });
const transcript = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("claudeProjectSlug", () => {
  it("replaces every non-alphanumeric character, spaces included", () => {
    expect(
      claudeProjectSlug("/Users/x/Library/Application Support/Daintree/help-sessions/0259afb3")
    ).toBe("-Users-x-Library-Application-Support-Daintree-help-sessions-0259afb3");
  });
});

describe("normalizePromptTitle", () => {
  it("unwraps pasted content and keeps the first line", () => {
    expect(
      normalizePromptTitle(
        '\n\n<pasted_content id="f19b">\n  Fix   the build\nmore\n</pasted_content>'
      )
    ).toBe("Fix the build");
  });

  it("caps long titles with an ellipsis", () => {
    const title = normalizePromptTitle("x".repeat(500));
    expect(title.length).toBe(120);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("summarizeClaudeTranscript", () => {
  it("filters a transcript holding only the launch greeting", () => {
    const text = transcript(
      prompt(HELP_ASSISTANT_GREETING),
      reply(),
      line({ type: "ai-title", aiTitle: "Daintree help offer" })
    );
    expect(summarizeClaudeTranscript(text, text)).toBeNull();
  });

  it("filters a transcript holding only a hub-started assistant's opening (#13392)", () => {
    const text = transcript(prompt(HUB_STARTED_ASSISTANT_GREETING), reply());
    expect(summarizeClaudeTranscript(text, text)).toBeNull();
  });

  it("ignores tool results and meta turns when looking for a real prompt", () => {
    const text = transcript(
      prompt(HELP_ASSISTANT_GREETING),
      toolResult(),
      prompt("Automated check-in", { isMeta: true }),
      reply()
    );
    expect(summarizeClaudeTranscript(text, text)).toBeNull();
  });

  it("keeps a greeting followed by a real prompt and titles it by the real prompt", () => {
    const text = transcript(
      prompt(HELP_ASSISTANT_GREETING),
      reply(),
      prompt("How do I add a worktree?")
    );
    expect(summarizeClaudeTranscript(text, text)).toEqual({ title: "How do I add a worktree?" });
  });

  it("prefers the newest custom title, then the newest ai-title, over the first prompt", () => {
    const withAi = transcript(
      prompt("first question"),
      line({ type: "ai-title", aiTitle: "Old title" }),
      line({ type: "ai-title", aiTitle: "New title" })
    );
    expect(summarizeClaudeTranscript(withAi, withAi)?.title).toBe("New title");

    const withCustom = transcript(
      prompt("first question"),
      line({ type: "custom-title", customTitle: "My name" }),
      line({ type: "ai-title", aiTitle: "Later ai title" })
    );
    expect(summarizeClaudeTranscript(withCustom, withCustom)?.title).toBe("My name");
  });

  it("reads prompts sent as text blocks", () => {
    const text = transcript(prompt([{ type: "text", text: "Block prompt" }]));
    expect(summarizeClaudeTranscript(text, text)?.title).toBe("Block prompt");
  });

  it("skips a partially written final line", () => {
    const text = `${transcript(prompt("Real question"))}{"type":"ai-title","aiTi`;
    expect(summarizeClaudeTranscript(text, text)).toEqual({ title: "Real question" });
  });

  it("takes the title from the tail and the first prompt from the head", () => {
    const head = `${transcript(prompt("Opening question"))}{"type":"assis`;
    const tail = `t":"x"}\n${transcript(line({ type: "ai-title", aiTitle: "Tail title" }))}`;
    expect(summarizeClaudeTranscript(head, tail, false)?.title).toBe("Tail title");
  });

  it("keeps a partially read transcript even when its edges show no real prompt", () => {
    const head = transcript(prompt(HELP_ASSISTANT_GREETING), reply());
    const tail = transcript(toolResult(), line({ type: "ai-title", aiTitle: "Long session" }));
    expect(summarizeClaudeTranscript(head, tail, false)).toEqual({ title: "Long session" });
  });

  it("counts a real last-prompt record as a real prompt", () => {
    const text = transcript(
      prompt(HELP_ASSISTANT_GREETING),
      line({ type: "last-prompt", lastPrompt: "Something real" }),
      line({ type: "ai-title", aiTitle: "Titled" })
    );
    expect(summarizeClaudeTranscript(text, text)?.title).toBe("Titled");
  });
});

describe("listClaudeHelpSessions", () => {
  let root: string;
  let projectsRoot: string;
  let sessionPath: string;
  let slugDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "help-past-sessions-"));
    projectsRoot = path.join(root, "projects");
    sessionPath = path.join(root, "Application Support", "help-sessions", "abc");
    await mkdir(sessionPath, { recursive: true });
    slugDir = path.join(projectsRoot, claudeProjectSlug(sessionPath));
    await mkdir(slugDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists real conversations with their mtime and drops greeting-only and foreign files", async () => {
    await writeFile(path.join(slugDir, `${A}.jsonl`), transcript(prompt("Real question")));
    await writeFile(path.join(slugDir, `${B}.jsonl`), transcript(prompt(HELP_ASSISTANT_GREETING)));
    await writeFile(path.join(slugDir, "not-a-session.jsonl"), transcript(prompt("Nope")));
    await writeFile(path.join(slugDir, `${C}.txt`), transcript(prompt("Nope")));
    const when = new Date("2026-01-02T03:04:05Z");
    await utimes(path.join(slugDir, `${A}.jsonl`), when, when);

    expect(await listClaudeHelpSessions(sessionPath, projectsRoot)).toEqual({
      sessions: [
        { agentId: "claude", sessionId: A, title: "Real question", updatedAt: when.getTime() },
      ],
      complete: true,
    });
  });

  it("does not follow a symlinked transcript", async () => {
    const outside = path.join(root, "outside.jsonl");
    await writeFile(outside, transcript(prompt("Planted")));
    await symlink(outside, path.join(slugDir, `${A}.jsonl`));
    expect(await listClaudeHelpSessions(sessionPath, projectsRoot)).toEqual({
      sessions: [],
      complete: true,
    });
  });

  it("does not follow a symlinked project folder", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, `${A}.jsonl`), transcript(prompt("Foreign")));
    await rm(slugDir, { recursive: true });
    await symlink(elsewhere, slugDir);
    expect(await listClaudeHelpSessions(sessionPath, projectsRoot)).toEqual({
      sessions: [],
      complete: true,
    });
  });

  it("returns nothing, and calls that the whole history, when the project folder does not exist", async () => {
    expect(await listClaudeHelpSessions(path.join(root, "missing"), projectsRoot)).toEqual({
      sessions: [],
      complete: true,
    });
  });

  describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("permissions", () => {
    afterEach(async () => {
      await chmod(slugDir, 0o755).catch(() => {});
      await chmod(path.join(slugDir, `${B}.jsonl`), 0o644).catch(() => {});
    });

    it("reports a project folder it can't read as incomplete rather than empty", async () => {
      await writeFile(path.join(slugDir, `${A}.jsonl`), transcript(prompt("Hidden")));
      await chmod(slugDir, 0o000);
      expect(await listClaudeHelpSessions(sessionPath, projectsRoot)).toEqual({
        sessions: [],
        complete: false,
      });
    });

    it("keeps the transcripts it could read when one can't be opened", async () => {
      await writeFile(path.join(slugDir, `${A}.jsonl`), transcript(prompt("Readable")));
      await writeFile(path.join(slugDir, `${B}.jsonl`), transcript(prompt("Locked")));
      await chmod(path.join(slugDir, `${B}.jsonl`), 0o000);
      const read = await listClaudeHelpSessions(sessionPath, projectsRoot);
      expect(read.sessions.map((s) => s.title)).toEqual(["Readable"]);
      expect(read.complete).toBe(false);
    });
  });

  it("reads only the edges of a large transcript", async () => {
    const filler = toolResult();
    const middle = Array.from({ length: 4000 }, () => filler);
    await writeFile(
      path.join(slugDir, `${A}.jsonl`),
      transcript(
        prompt("Opening question"),
        ...middle,
        line({ type: "ai-title", aiTitle: "Final title" })
      )
    );
    const {
      sessions: [session],
    } = await listClaudeHelpSessions(sessionPath, projectsRoot);
    expect(session?.title).toBe("Final title");
  });
});

describe("codexHelpSessionsFrom", () => {
  it("prefers the thread name, falls back to the preview, and never names a row after the greeting", () => {
    expect(
      codexHelpSessionsFrom({
        status: "ok",
        sessions: [
          { id: "t1", preview: "Question one", name: "Named thread", updatedAt: 3 },
          { id: "t2", preview: "Question two", updatedAt: 2 },
          // Codex reports only the first message, so a session that opened with
          // the greeting may have run long after it: kept, but not titled by it.
          { id: "t3", preview: HELP_ASSISTANT_GREETING, updatedAt: 1 },
          { id: "t4", preview: "", updatedAt: 0 },
        ],
      })
    ).toEqual([
      { agentId: "codex", sessionId: "t1", title: "Named thread", updatedAt: 3 },
      { agentId: "codex", sessionId: "t2", title: "Question two", updatedAt: 2 },
      { agentId: "codex", sessionId: "t3", title: "Untitled conversation", updatedAt: 1 },
    ]);
  });

  it("returns nothing when Codex is unavailable", () => {
    expect(codexHelpSessionsFrom({ status: "unavailable", reason: "cli-missing" })).toEqual([]);
  });
});

describe("listHelpPastSessions", () => {
  const NO_PATHS = {
    claude: "/nonexistent/help-sessions/x",
    codex: ["/nonexistent/help-sessions/x"],
  };

  it("reads Codex history from each of its directories and lists a conversation once", async () => {
    const listCodexSessions = vi.fn(async (cwd: string) =>
      cwd === "/sessions/h.codex"
        ? {
            status: "ok" as const,
            sessions: [
              { id: "resumed", preview: "Picked back up", updatedAt: 40 },
              { id: "fresh", preview: "Started here", updatedAt: 30 },
            ],
          }
        : {
            status: "ok" as const,
            sessions: [
              { id: "resumed", preview: "Picked back up", updatedAt: 10 },
              { id: "legacy", preview: "From the shared folder", updatedAt: 20 },
            ],
          }
    );
    const merged = await listHelpPastSessions(
      { claude: "/nonexistent/help-sessions/h", codex: ["/sessions/h.codex", "/sessions/h"] },
      { claudeProjectsRoot: "/nonexistent/projects", listCodexSessions }
    );
    expect(listCodexSessions.mock.calls.map(([cwd]) => cwd)).toEqual([
      "/sessions/h.codex",
      "/sessions/h",
    ]);
    expect(merged.sessions.map((s) => [s.sessionId, s.updatedAt])).toEqual([
      ["resumed", 40],
      ["fresh", 30],
      ["legacy", 20],
    ]);
  });

  it("keeps the newest copy of a conversation whichever directory reports it first, and survives one failing", async () => {
    const merged = await listHelpPastSessions(
      {
        claude: "/nonexistent/help-sessions/h",
        codex: ["/sessions/h.codex", "/sessions/h", "/gone"],
      },
      {
        claudeProjectsRoot: "/nonexistent/projects",
        listCodexSessions: async (cwd) => {
          if (cwd === "/gone") throw new Error("unreadable");
          return {
            status: "ok",
            sessions:
              cwd === "/sessions/h.codex"
                ? [{ id: "resumed", preview: "Older copy", updatedAt: 10 }]
                : [{ id: "resumed", preview: "Newer copy", updatedAt: 50 }],
          };
        },
      }
    );
    expect(merged.sessions.map((s) => [s.sessionId, s.title, s.updatedAt])).toEqual([
      ["resumed", "Newer copy", 50],
    ]);
    expect(merged.unreadable).toEqual(["codex"]);
  });

  it("caps after merging the directories, so duplicates never cost a row", async () => {
    const shared = Array.from({ length: HELP_PAST_SESSIONS_LIMIT }, (_, i) => ({
      id: `t${i}`,
      preview: `Question ${i}`,
      updatedAt: i,
    }));
    const merged = await listHelpPastSessions(
      { claude: "/nonexistent/help-sessions/h", codex: ["/sessions/h.codex", "/sessions/h"] },
      {
        claudeProjectsRoot: "/nonexistent/projects",
        listCodexSessions: async (cwd) => ({
          status: "ok",
          sessions:
            cwd === "/sessions/h"
              ? [...shared, { id: "extra", preview: "Extra", updatedAt: -1 }]
              : shared,
        }),
      }
    );
    expect(merged.sessions).toHaveLength(HELP_PAST_SESSIONS_LIMIT);
    expect(new Set(merged.sessions.map((s) => s.sessionId)).size).toBe(HELP_PAST_SESSIONS_LIMIT);
    expect(merged.truncated).toBe(true);
  });

  it("merges both stores newest first and survives one failing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "help-past-merge-"));
    try {
      const sessionPath = path.join(root, "s");
      await mkdir(sessionPath);
      const slugDir = path.join(root, "projects", claudeProjectSlug(sessionPath));
      await mkdir(slugDir, { recursive: true });
      await writeFile(path.join(slugDir, `${A}.jsonl`), transcript(prompt("Claude one")));
      const when = new Date(2000);
      await utimes(path.join(slugDir, `${A}.jsonl`), when, when);

      const merged = await listHelpPastSessions(
        { claude: sessionPath, codex: [sessionPath] },
        {
          claudeProjectsRoot: path.join(root, "projects"),
          listCodexSessions: async () => ({
            status: "ok",
            sessions: [
              { id: "newer", preview: "Codex newer", updatedAt: 3000 },
              { id: "older", preview: "Codex older", updatedAt: 1000 },
            ],
          }),
        }
      );
      expect(merged).toEqual({
        sessions: expect.any(Array),
        unreadable: [],
        truncated: false,
      });
      expect(merged.sessions.map((s) => s.sessionId)).toEqual(["newer", A, "older"]);

      const claudeOnly = await listHelpPastSessions(
        { claude: sessionPath, codex: [sessionPath] },
        {
          claudeProjectsRoot: path.join(root, "projects"),
          listCodexSessions: () => Promise.reject(new Error("boom")),
        }
      );
      expect(claudeOnly.sessions.map((s) => s.sessionId)).toEqual([A]);
      expect(claudeOnly.unreadable).toEqual(["codex"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("orders equal times by identity so the list is stable", async () => {
    const merged = await listHelpPastSessions(NO_PATHS, {
      claudeProjectsRoot: "/nonexistent/projects",
      listCodexSessions: async () => ({
        status: "ok",
        sessions: [
          { id: "b", preview: "B", updatedAt: 5 },
          { id: "a", preview: "A", updatedAt: 5 },
        ],
      }),
    });
    expect(merged.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("caps the merged list", async () => {
    const sessions = Array.from({ length: HELP_PAST_SESSIONS_LIMIT + 5 }, (_, i) => ({
      id: `t${i}`,
      preview: `Question ${i}`,
      updatedAt: i,
    }));
    const merged = await listHelpPastSessions(NO_PATHS, {
      claudeProjectsRoot: "/nonexistent/projects",
      listCodexSessions: async () => ({ status: "ok", sessions }),
    });
    expect(merged.sessions).toHaveLength(HELP_PAST_SESSIONS_LIMIT);
    expect(merged.sessions[0]?.sessionId).toBe(`t${HELP_PAST_SESSIONS_LIMIT + 4}`);
    expect(merged.truncated).toBe(true);
  });

  it("calls a list that fits under the cap whole", async () => {
    const sessions = Array.from({ length: HELP_PAST_SESSIONS_LIMIT }, (_, i) => ({
      id: `t${i}`,
      preview: `Question ${i}`,
      updatedAt: i,
    }));
    const merged = await listHelpPastSessions(NO_PATHS, {
      claudeProjectsRoot: "/nonexistent/projects",
      listCodexSessions: async () => ({ status: "ok", sessions }),
    });
    expect(merged.sessions).toHaveLength(HELP_PAST_SESSIONS_LIMIT);
    expect(merged.truncated).toBe(false);
  });

  it("calls the list cut when Codex left older threads off its page, however few came back", async () => {
    const merged = await listHelpPastSessions(NO_PATHS, {
      claudeProjectsRoot: "/nonexistent/projects",
      listCodexSessions: async () => ({
        status: "ok",
        sessions: [{ id: "t1", preview: "Question", updatedAt: 1 }],
        more: true,
      }),
    });
    expect(merged.sessions).toHaveLength(1);
    expect(merged.truncated).toBe(true);
  });

  it("names Codex unreadable when its app server fails, and keeps Claude's rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "help-past-codex-down-"));
    try {
      const sessionPath = path.join(root, "s");
      await mkdir(sessionPath);
      const slugDir = path.join(root, "projects", claudeProjectSlug(sessionPath));
      await mkdir(slugDir, { recursive: true });
      await writeFile(path.join(slugDir, `${A}.jsonl`), transcript(prompt("Claude one")));
      for (const reason of ["timeout", "protocol-error"] as const) {
        const merged = await listHelpPastSessions(
          { claude: sessionPath, codex: [`${sessionPath}.codex`, sessionPath] },
          {
            claudeProjectsRoot: path.join(root, "projects"),
            listCodexSessions: async () => ({ status: "unavailable", reason }),
          }
        );
        expect(merged.sessions.map((s) => s.sessionId)).toEqual([A]);
        expect(merged.unreadable).toEqual(["codex"]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a missing Codex CLI as no history unless Codex's own directory shows it ran", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "help-past-cli-missing-"));
    try {
      const claudePath = path.join(root, "h");
      const codexPath = path.join(root, "h.codex");
      // The shared pre-split directory is Claude's, so it exists for every Claude user.
      await mkdir(claudePath);
      const deps = {
        claudeProjectsRoot: path.join(root, "projects"),
        listCodexSessions: async () => ({
          status: "unavailable" as const,
          reason: "cli-missing" as const,
        }),
      };
      const paths = { claude: claudePath, codex: [codexPath, claudePath] };

      expect(await listHelpPastSessions(paths, deps)).toEqual({
        sessions: [],
        unreadable: [],
        truncated: false,
      });

      await mkdir(codexPath);
      expect((await listHelpPastSessions(paths, deps)).unreadable).toEqual(["codex"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "counts a missing Codex CLI when Codex's own directory can't be inspected",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "help-past-cli-locked-"));
      const locked = path.join(root, "help-sessions");
      try {
        await mkdir(path.join(locked, "h.codex"), { recursive: true });
        await chmod(locked, 0o000);
        const merged = await listHelpPastSessions(
          { claude: path.join(locked, "h"), codex: [path.join(locked, "h.codex")] },
          {
            claudeProjectsRoot: path.join(root, "projects"),
            listCodexSessions: async () => ({ status: "unavailable", reason: "cli-missing" }),
          }
        );
        expect(merged.unreadable).toContain("codex");
      } finally {
        await chmod(locked, 0o755);
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("names Claude unreadable when its session path can't be resolved, and keeps Codex's rows", async () => {
    const merged = await listHelpPastSessions(
      // A NUL byte fails `realpath` with something other than "not there".
      { claude: "/bad\0path", codex: ["/sessions/h.codex"] },
      {
        claudeProjectsRoot: "/nonexistent/projects",
        listCodexSessions: async () => ({
          status: "ok",
          sessions: [{ id: "t1", preview: "Codex one", updatedAt: 1 }],
        }),
      }
    );
    expect(merged.sessions.map((s) => s.sessionId)).toEqual(["t1"]);
    expect(merged.unreadable).toEqual(["claude"]);
  });

  it("names both stores when both fail", async () => {
    const merged = await listHelpPastSessions(
      { claude: "/bad\0path", codex: ["/sessions/h.codex"] },
      {
        claudeProjectsRoot: "/nonexistent/projects",
        listCodexSessions: async () => ({ status: "unavailable", reason: "timeout" }),
      }
    );
    expect(merged).toEqual({ sessions: [], unreadable: ["claude", "codex"], truncated: false });
  });

  it("counts after merging the directories, so one conversation seen twice never cuts the list", async () => {
    const page = Array.from({ length: HELP_PAST_SESSIONS_LIMIT }, (_, i) => ({
      id: `t${i}`,
      preview: `Question ${i}`,
      updatedAt: i,
    }));
    const merged = await listHelpPastSessions(
      { claude: "/nonexistent/help-sessions/h", codex: ["/sessions/h.codex", "/sessions/h"] },
      {
        claudeProjectsRoot: "/nonexistent/projects",
        listCodexSessions: async () => ({ status: "ok", sessions: page }),
      }
    );
    expect(merged.sessions).toHaveLength(HELP_PAST_SESSIONS_LIMIT);
    expect(merged.truncated).toBe(false);
  });

  it("keeps a cut legacy page's news when Codex's own directory failed", async () => {
    const merged = await listHelpPastSessions(
      { claude: "/nonexistent/help-sessions/h", codex: ["/sessions/h.codex", "/sessions/h"] },
      {
        claudeProjectsRoot: "/nonexistent/projects",
        listCodexSessions: async (cwd) =>
          cwd === "/sessions/h.codex"
            ? { status: "unavailable", reason: "timeout" }
            : {
                status: "ok",
                sessions: [{ id: "legacy", preview: "Older", updatedAt: 1 }],
                more: true,
              },
      }
    );
    expect(merged).toEqual({
      sessions: [expect.objectContaining({ sessionId: "legacy" })],
      unreadable: ["codex"],
      truncated: true,
    });
  });
});
