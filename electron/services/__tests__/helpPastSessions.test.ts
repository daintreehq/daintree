import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  HELP_PAST_SESSIONS_LIMIT,
  claudeProjectSlug,
  codexHelpSessionsFrom,
  listClaudeHelpSessions,
  listHelpPastSessions,
  normalizePromptTitle,
  summarizeClaudeTranscript,
} from "../helpPastSessions.js";
import { HELP_ASSISTANT_GREETING } from "../../../shared/config/helpAssistantGreeting.js";

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

    const sessions = await listClaudeHelpSessions(sessionPath, projectsRoot);
    expect(sessions).toEqual([
      { agentId: "claude", sessionId: A, title: "Real question", updatedAt: when.getTime() },
    ]);
  });

  it("does not follow a symlinked transcript", async () => {
    const outside = path.join(root, "outside.jsonl");
    await writeFile(outside, transcript(prompt("Planted")));
    await symlink(outside, path.join(slugDir, `${A}.jsonl`));
    expect(await listClaudeHelpSessions(sessionPath, projectsRoot)).toEqual([]);
  });

  it("returns nothing when the project folder does not exist", async () => {
    expect(await listClaudeHelpSessions(path.join(root, "missing"), projectsRoot)).toEqual([]);
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
    const [session] = await listClaudeHelpSessions(sessionPath, projectsRoot);
    expect(session?.title).toBe("Final title");
  });
});

describe("codexHelpSessionsFrom", () => {
  it("prefers the thread name, falls back to the preview, and drops greeting-only threads", () => {
    expect(
      codexHelpSessionsFrom({
        status: "ok",
        sessions: [
          { id: "t1", preview: "Question one", name: "Named thread", updatedAt: 3 },
          { id: "t2", preview: "Question two", updatedAt: 2 },
          { id: "t3", preview: HELP_ASSISTANT_GREETING, updatedAt: 1 },
          { id: "t4", preview: "", updatedAt: 0 },
        ],
      })
    ).toEqual([
      { agentId: "codex", sessionId: "t1", title: "Named thread", updatedAt: 3 },
      { agentId: "codex", sessionId: "t2", title: "Question two", updatedAt: 2 },
    ]);
  });

  it("returns nothing when Codex is unavailable", () => {
    expect(codexHelpSessionsFrom({ status: "unavailable", reason: "cli-missing" })).toEqual([]);
  });
});

describe("listHelpPastSessions", () => {
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

      const merged = await listHelpPastSessions(sessionPath, {
        claudeProjectsRoot: path.join(root, "projects"),
        listCodexSessions: async () => ({
          status: "ok",
          sessions: [
            { id: "newer", preview: "Codex newer", updatedAt: 3000 },
            { id: "older", preview: "Codex older", updatedAt: 1000 },
          ],
        }),
      });
      expect(merged.map((s) => s.sessionId)).toEqual(["newer", A, "older"]);

      const claudeOnly = await listHelpPastSessions(sessionPath, {
        claudeProjectsRoot: path.join(root, "projects"),
        listCodexSessions: () => Promise.reject(new Error("boom")),
      });
      expect(claudeOnly.map((s) => s.sessionId)).toEqual([A]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps the merged list", async () => {
    const sessions = Array.from({ length: HELP_PAST_SESSIONS_LIMIT + 5 }, (_, i) => ({
      id: `t${i}`,
      preview: `Question ${i}`,
      updatedAt: i,
    }));
    const merged = await listHelpPastSessions("/nonexistent/help-sessions/x", {
      claudeProjectsRoot: "/nonexistent/projects",
      listCodexSessions: async () => ({ status: "ok", sessions }),
    });
    expect(merged).toHaveLength(HELP_PAST_SESSIONS_LIMIT);
    expect(merged[0]?.sessionId).toBe(`t${HELP_PAST_SESSIONS_LIMIT + 4}`);
  });
});
