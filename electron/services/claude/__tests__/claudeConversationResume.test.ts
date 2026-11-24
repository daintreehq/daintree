import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { resumeClaudeFromConversationStore } from "../claudeConversationResume.js";
import { escapeShellArg } from "../../../../shared/utils/shellEscape.js";

const SESSION = "006fdfc0-67bf-4df0-ad82-48ebfe4df184";
const OTHER = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/work/app";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), "claude-conversation-resume-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function writeTranscript(projectDir: string, sessionId: string): Promise<string> {
  const dir = path.join(configDir, "projects", projectDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, '{"type":"user"}\n');
  return file;
}

describe("resumeClaudeFromConversationStore", () => {
  it("resumes the conversation by the path of the transcript it found", async () => {
    const file = await writeTranscript("-work-app", SESSION);

    await expect(
      resumeClaudeFromConversationStore(
        `claude --verbose --resume ${SESSION}`,
        { sessionId: SESSION, configDir },
        CWD
      )
    ).resolves.toBe(`claude --verbose --resume ${escapeShellArg(file, "posix")}`);
  });

  it("finds it under a project folder the CLI named some other way", async () => {
    // Long folder names are truncated and hashed, so the slug is never built.
    const file = await writeTranscript("-work-app-1a2b3c", SESSION);

    await expect(
      resumeClaudeFromConversationStore(
        `claude --resume ${SESSION}`,
        { sessionId: SESSION, configDir },
        CWD
      )
    ).resolves.toBe(`claude --resume ${escapeShellArg(file, "posix")}`);
  });

  it("leaves the resume by id when the folder doesn't hold it", async () => {
    await writeTranscript("-work-app", OTHER);

    await expect(
      resumeClaudeFromConversationStore(
        `claude --resume ${SESSION}`,
        { sessionId: SESSION, configDir },
        CWD
      )
    ).resolves.toBeUndefined();
    await expect(
      resumeClaudeFromConversationStore(
        `claude --resume ${SESSION}`,
        { sessionId: SESSION, configDir: path.join(configDir, "gone") },
        CWD
      )
    ).resolves.toBeUndefined();
  });

  it("reads nothing for a command that resumes another conversation", async () => {
    const locate = vi.fn();

    await expect(
      resumeClaudeFromConversationStore(
        `claude --resume ${OTHER}`,
        { sessionId: SESSION, configDir },
        CWD,
        { locate }
      )
    ).resolves.toBeUndefined();
    await expect(
      resumeClaudeFromConversationStore(
        "claude --continue",
        { sessionId: SESSION, configDir },
        CWD,
        { locate }
      )
    ).resolves.toBeUndefined();
    expect(locate).not.toHaveBeenCalled();
  });

  it("gives up on a folder that doesn't answer in time, and stops the search", async () => {
    let signal: AbortSignal | undefined;
    const locate = vi.fn((_location: unknown, given?: AbortSignal) => {
      signal = given;
      return new Promise<never>(() => {});
    });

    await expect(
      resumeClaudeFromConversationStore(
        `claude --resume ${SESSION}`,
        { sessionId: SESSION, configDir },
        CWD,
        { locate, timeoutMs: 10 }
      )
    ).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("leaves the resume by id when the lookup fails", async () => {
    const locate = vi.fn().mockRejectedValue(new Error("EACCES"));

    await expect(
      resumeClaudeFromConversationStore(
        `claude --resume ${SESSION}`,
        { sessionId: SESSION, configDir },
        CWD,
        { locate }
      )
    ).resolves.toBeUndefined();
  });
});
