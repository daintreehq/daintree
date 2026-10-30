import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readVoiceOpeningCommand } from "../voiceOpeningCommand.js";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { getBuiltinSlashCommands, type SlashCommand } from "../../../shared/types/slashCommands.js";
import {
  buildVoiceCommandVocabulary,
  type VoiceCommandEntry,
} from "../../../shared/utils/voiceAgentCommands.js";

let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-opening-command-"));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function write(relative: string, contents: string): Promise<string> {
  const filePath = path.join(root, relative);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
  return filePath;
}

// Entries as the target's vocabulary holds them: discovery's commands, keyed by
// the prefixes the agent declares.
function entriesFor(agentId: BuiltInAgentId, commands: SlashCommand[]): VoiceCommandEntry[] {
  return [
    ...buildVoiceCommandVocabulary(
      [...commands, ...getBuiltinSlashCommands(agentId)],
      getAgentConfig(agentId)!.completionSources!
    ).entries,
  ];
}

function discovered(
  agentId: BuiltInAgentId,
  label: string,
  sourcePath: string,
  extra: Partial<SlashCommand> = {}
): SlashCommand {
  return {
    id: `user:${label}`,
    label,
    description: "Listing description",
    scope: "user",
    agentId,
    sourcePath,
    kind: "skill",
    trigger: label.startsWith("$") ? "$" : "/",
    ...extra,
  };
}

describe("readVoiceOpeningCommand", () => {
  it("reads a Claude Code skill's full description, argument hint and the start of its body", async () => {
    const skill = await write(
      "claude/skills/release-notes/SKILL.md",
      [
        "---",
        "name: release-notes",
        "description: >-",
        "  Draft release notes from the merged pull requests",
        "  since the last tag, grouped by area.",
        'argument-hint: "[tag] [--draft]"',
        "allowed-tools: Bash(git log:*)",
        "---",
        "",
        "# Release notes",
        "",
        "",
        "",
        "Read the merged pull requests since $ARGUMENTS and group them by area.",
      ].join("\n")
    );
    const entries = entriesFor("claude", [
      discovered("claude", "/release-notes", skill, { description: ">-" }),
    ]);

    expect(await readVoiceOpeningCommand(entries, "/release-notes")).toEqual({
      token: "/release-notes",
      description:
        "Draft release notes from the merged pull requests since the last tag, grouped by area.",
      argumentHint: "[tag] [--draft]",
      excerpt:
        "# Release notes\n\nRead the merged pull requests since $ARGUMENTS and group them by area.",
    });
  });

  it("reads a Codex skill invoked with `$`", async () => {
    const skill = await write(
      "codex/skills/plugin-creator/SKILL.md",
      [
        "---",
        "name: plugin-creator",
        "description: Scaffold a Codex plugin with its manifest and first skill.",
        "metadata:",
        "  short-description: Scaffold a plugin",
        "---",
        "Ask for the plugin's name, then create `.codex-plugin/plugin.json`.",
      ].join("\n")
    );
    const entries = entriesFor("codex", [discovered("codex", "$plugin-creator", skill)]);

    expect(await readVoiceOpeningCommand(entries, "$plugin-creator")).toEqual({
      token: "$plugin-creator",
      description: "Scaffold a Codex plugin with its manifest and first skill.",
      excerpt: "Ask for the plugin's name, then create `.codex-plugin/plugin.json`.",
    });
  });

  it("gives a built-in, which has no file, only its description", async () => {
    const entries = entriesFor("claude", []);
    const compact = entries.find((entry) => entry.token === "/compact")!;
    expect(compact.sourcePath).toBeUndefined();

    expect(await readVoiceOpeningCommand(entries, "/compact")).toEqual({
      token: "/compact",
      description: compact.description,
    });
  });

  it("reads a Claude Code command without frontmatter as all body, with its listing description", async () => {
    const command = await write("claude/commands/deploy.md", "Deploy $ARGUMENTS to staging.\n");
    const entries = entriesFor("claude", [
      discovered("claude", "/deploy", command, { kind: "command", description: "Custom command" }),
    ]);

    expect(await readVoiceOpeningCommand(entries, "/deploy")).toEqual({
      token: "/deploy",
      description: "Custom command",
      excerpt: "Deploy $ARGUMENTS to staging.",
    });
  });

  it("reads a Gemini command's prompt from its TOML", async () => {
    const command = await write(
      "gemini/commands/git/commit.toml",
      [
        'description = "Write a commit message for the staged changes"',
        'prompt = """',
        "Write a conventional commit message for: {{args}}",
        '"""',
      ].join("\n")
    );
    const entries = entriesFor("gemini", [
      discovered("gemini", "/git:commit", command, { kind: "command" }),
    ]);

    expect(await readVoiceOpeningCommand(entries, "/git:commit")).toEqual({
      token: "/git:commit",
      description: "Write a commit message for the staged changes",
      excerpt: "Write a conventional commit message for: {{args}}",
    });
  });

  it("reads an Antigravity skill, named by its frontmatter", async () => {
    const skill = await write(
      "antigravity/skills/antigravity_guide/SKILL.md",
      "---\nname: antigravity-guide\ndescription: How Antigravity works\n---\nExplain the planner.\n"
    );
    const entries = entriesFor("antigravity", [
      discovered("antigravity", "/antigravity-guide", skill),
    ]);

    expect(await readVoiceOpeningCommand(entries, "/antigravity-guide")).toEqual({
      token: "/antigravity-guide",
      description: "How Antigravity works",
      excerpt: "Explain the planner.",
    });
  });

  it("reads a Codex plugin's longer description from its manifest, which has no body", async () => {
    const manifest = await write(
      "codex/plugins/cache/market/github/1.0.0/.codex-plugin/plugin.json",
      JSON.stringify({
        description: "GitHub",
        interface: {
          shortDescription: "GitHub tools",
          longDescription: "Read issues, pull requests and CI runs from GitHub.",
        },
      })
    );
    const entries = entriesFor("codex", [
      discovered("codex", "$github", manifest, { kind: "plugin" }),
    ]);

    expect(await readVoiceOpeningCommand(entries, "$github")).toEqual({
      token: "$github",
      description: "Read issues, pull requests and CI runs from GitHub.",
    });
  });

  it("reads past a byte-order mark and Windows line endings", async () => {
    const skill = await write(
      "claude/skills/crlf/SKILL.md",
      "﻿---\r\ndescription: Line endings\r\nargument-hint: <file>\r\n---\r\nFirst line\r\nSecond line\r\n"
    );
    const entries = entriesFor("claude", [discovered("claude", "/crlf", skill)]);

    expect(await readVoiceOpeningCommand(entries, "/crlf")).toEqual({
      token: "/crlf",
      description: "Line endings",
      argumentHint: "<file>",
      excerpt: "First line\nSecond line",
    });
  });

  it("cuts a long body to a bounded excerpt", async () => {
    const skill = await write(
      "claude/skills/long/SKILL.md",
      `---\ndescription: Long\n---\n${"step through the queue ".repeat(400)}`
    );
    const entries = entriesFor("claude", [discovered("claude", "/long", skill)]);

    const { excerpt } = (await readVoiceOpeningCommand(entries, "/long"))!;
    expect(excerpt!.length).toBeLessThanOrEqual(2_000);
    expect(excerpt!.endsWith("…")).toBe(true);
    expect(excerpt!.startsWith("step through the queue step")).toBe(true);
  });

  it("falls back to the listing when the file is gone or its frontmatter was cut off", async () => {
    const cut = await write(
      "claude/skills/cut/SKILL.md",
      `---\ndescription: Cut\nnotes: ${"x".repeat(40_000)}\n---\nBody\n`
    );
    const entries = entriesFor("claude", [
      discovered("claude", "/gone", path.join(root, "claude/skills/gone/SKILL.md")),
      discovered("claude", "/cut", cut),
    ]);

    expect(await readVoiceOpeningCommand(entries, "/gone")).toEqual({
      token: "/gone",
      description: "Listing description",
    });
    expect(await readVoiceOpeningCommand(entries, "/cut")).toEqual({
      token: "/cut",
      description: "Listing description",
    });
  });

  it("sends nothing for no token, or one the target doesn't list", async () => {
    const entries = entriesFor("claude", []);
    expect(await readVoiceOpeningCommand(entries, undefined)).toBeUndefined();
    expect(await readVoiceOpeningCommand(entries, "/not-a-command")).toBeUndefined();
    // Codex lists its skills under `$`, so a `/` spelling of one is no match.
    const skill = await write("codex/skills/lint/SKILL.md", "---\ndescription: Lint\n---\nRun it");
    const codex = entriesFor("codex", [discovered("codex", "$lint", skill)]);
    expect(await readVoiceOpeningCommand(codex, "/lint")).toBeUndefined();
  });

  it("screens what it read like the command list: a secret-shaped name sends nothing, a credential drops its part", async () => {
    const key = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    const leaky = await write(
      "claude/skills/leaky/SKILL.md",
      `---\ndescription: Calls the API with ${key}\nargument-hint: "[model]"\n---\nUse the model the speaker names.\n`
    );
    const leakyBody = await write(
      "claude/skills/leaky-body/SKILL.md",
      `---\ndescription: Calls the API\n---\nexport OPENAI_API_KEY=${key}\nThen run it.\n`
    );
    const entries = entriesFor("claude", [
      discovered("claude", "/leaky", leaky),
      discovered("claude", "/leaky-body", leakyBody),
      discovered("claude", `/${key}`, leaky),
    ]);

    // The file's description held a credential, so the listing's doesn't stand in for it.
    expect(await readVoiceOpeningCommand(entries, "/leaky")).toEqual({
      token: "/leaky",
      argumentHint: "[model]",
      excerpt: "Use the model the speaker names.",
    });
    expect(await readVoiceOpeningCommand(entries, "/leaky-body")).toEqual({
      token: "/leaky-body",
      description: "Calls the API",
    });
    expect(await readVoiceOpeningCommand(entries, `/${key}`)).toBeUndefined();
  });

  it("screens a credential the excerpt's cut runs through", async () => {
    const key = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    const skill = await write(
      "claude/skills/edge/SKILL.md",
      `---\ndescription: Edge\n---\n${"a".repeat(1_990)} ${key}\n`
    );
    const clean = await write(
      "claude/skills/edge-clean/SKILL.md",
      `---\ndescription: Edge\n---\n${"a".repeat(1_990)} and the rest of it\n`
    );
    const entries = entriesFor("claude", [
      discovered("claude", "/edge", skill),
      discovered("claude", "/edge-clean", clean),
    ]);

    expect(await readVoiceOpeningCommand(entries, "/edge")).toEqual({
      token: "/edge",
      description: "Edge",
    });
    // The same cut without a credential past it keeps its excerpt.
    expect((await readVoiceOpeningCommand(entries, "/edge-clean"))!.excerpt).toMatch(/^a+ and the…$/);
  });

  it("gives up on a file it can't open in time, with one open however many cleanups ask", async () => {
    const skill = await write("claude/skills/slow/SKILL.md", "---\ndescription: Slow\n---\nBody\n");
    const open = vi.spyOn(fsp, "open").mockReturnValue(new Promise(() => {}));
    const entries = entriesFor("claude", [discovered("claude", "/slow", skill)]);

    const reads = await Promise.all([
      readVoiceOpeningCommand(entries, "/slow"),
      readVoiceOpeningCommand(entries, "/slow"),
    ]);

    expect(reads).toEqual([
      { token: "/slow", description: "Listing description" },
      { token: "/slow", description: "Listing description" },
    ]);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
