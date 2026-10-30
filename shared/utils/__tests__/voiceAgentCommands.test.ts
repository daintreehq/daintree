import { describe, expect, it } from "vitest";
import { getAgentConfig } from "../../config/agentRegistry.js";
import { getBuiltinSlashCommands, type SlashCommand } from "../../types/slashCommands.js";
import type { CompletionSourceConfig } from "../../types/completionSources.js";
import {
  EMPTY_VOICE_COMMAND_VOCABULARY,
  buildVoiceCommandVocabulary,
  classifySpokenCommandOpening,
  openingVoiceCommandToken,
  opensWithVoiceCommand,
  planSpokenCommand,
  rewriteSpokenCommand,
  voiceCommandKeyterms,
} from "../voiceAgentCommands.js";

function sourcesOf(agentId: "claude" | "codex"): readonly CompletionSourceConfig[] {
  return getAgentConfig(agentId)!.completionSources!;
}

function custom(
  agentId: "claude" | "codex",
  token: string,
  overrides: Partial<SlashCommand> = {}
): SlashCommand {
  return {
    id: `project:${token}`,
    label: token,
    insertText: token,
    description: `Runs ${token}`,
    scope: "project",
    agentId,
    trigger: token.startsWith("$") ? "$" : "/",
    ...overrides,
  };
}

const claude = buildVoiceCommandVocabulary(
  [
    ...getBuiltinSlashCommands("claude"),
    custom("claude", "/pr-comments"),
    custom("claude", "/frontend:component", { scope: "user" }),
    custom("claude", "/ship-it", { kind: "skill" }),
  ],
  sourcesOf("claude")
);

// Codex retired `/prompts:`, so it's declared here the way any agent could.
const codexSources: readonly CompletionSourceConfig[] = [
  ...sourcesOf("codex"),
  {
    id: "prompts",
    trigger: "/",
    sourcePrecedence: 5,
    discovery: {
      method: "directory",
      parser: "markdown-frontmatter",
      derive: { labelPrefix: "/prompts:", kind: "command", fallbackDescription: "Prompt" },
      locations: [],
    },
  },
];

const codex = buildVoiceCommandVocabulary(
  [
    ...getBuiltinSlashCommands("codex"),
    custom("codex", "$plugin-creator", { kind: "skill", label: "Plugin Creator" }),
    custom("codex", "$github", { kind: "plugin", scope: "user" }),
    custom("codex", "/prompts:deploy", { scope: "user" }),
  ],
  codexSources
);

describe("buildVoiceCommandVocabulary", () => {
  it("keys each command by the prefix its registry source declares", () => {
    const byToken = new Map(codex.entries.map((entry) => [entry.token, entry]));
    expect(byToken.get("$plugin-creator")).toMatchObject({
      prefix: "$",
      spokenName: "plugin creator",
      key: "plugincreator",
    });
    expect(byToken.get("/prompts:deploy")).toMatchObject({ prefix: "/prompts:", key: "deploy" });
    expect(byToken.get("/compact")).toMatchObject({ prefix: "/", scope: "built-in" });
  });

  it("orders the user's own commands before built-ins", () => {
    const scopes = claude.entries.map((entry) => entry.scope);
    expect(scopes.slice(0, 3)).toEqual(["project", "project", "user"]);
    expect(scopes.indexOf("built-in")).toBeGreaterThan(scopes.lastIndexOf("user"));
  });

  it("keeps the file discovery read a command from, and none for a built-in", () => {
    const vocabulary = buildVoiceCommandVocabulary(
      [
        custom("claude", "/ship-it", { sourcePath: "/home/dev/.claude/skills/ship-it/SKILL.md" }),
        ...getBuiltinSlashCommands("claude"),
      ],
      sourcesOf("claude")
    );
    const byToken = new Map(vocabulary.entries.map((entry) => [entry.token, entry]));
    expect(byToken.get("/ship-it")!.sourcePath).toBe("/home/dev/.claude/skills/ship-it/SKILL.md");
    expect(byToken.get("/compact")).not.toHaveProperty("sourcePath");
  });

  it("leaves out a command no declared prefix opens", () => {
    const vocabulary = buildVoiceCommandVocabulary(
      [custom("claude", "$stray", { trigger: "$" })],
      sourcesOf("claude")
    );
    expect(vocabulary.entries).toEqual([]);
  });
});

describe("rewriteSpokenCommand", () => {
  it.each([
    ["Slash review the last commit.", "/review the last commit."],
    ["slash compact", "/compact"],
    ["Slash compact.", "/compact"],
    ["/ review the last commit", "/review the last commit"],
    ["/Review, the last commit", "/review the last commit"],
    ["Slash PR comments for 123", "/pr-comments for 123"],
    ["slash prcomments", "/pr-comments"],
    ["Forward slash frontend component a modal", "/frontend:component a modal"],
    ["slash ship it now", "/ship-it now"],
    ["slash review --force ./src/app.ts", "/review --force ./src/app.ts"],
    ["Slash review @src/App.tsx and `npm test`", "/review @src/App.tsx and `npm test`"],
  ])("Claude Code: %j → %j", (spoken, written) => {
    expect(rewriteSpokenCommand(spoken, claude)).toBe(written);
  });

  it.each([
    ["Dollar plugin creator for the linter", "$plugin-creator for the linter"],
    ["dollar sign github open the PR", "$github open the PR"],
    ["$ plugin creator", "$plugin-creator"],
    ["Slash prompts deploy to staging", "/prompts:deploy to staging"],
    ["slash prompts colon deploy", "/prompts:deploy"],
    ["Slash compact.", "/compact"],
  ])("Codex: %j → %j", (spoken, written) => {
    expect(rewriteSpokenCommand(spoken, codex)).toBe(written);
  });

  it.each([
    "Slash the budget in half.",
    "slash reviews are slow",
    "Slash and burn the old code.",
    "Review the last commit.",
    "Compact the conversation.",
    "Use a slash compact separator.",
    "/usr/local/bin is missing",
    "Dollar amounts must round to two places.",
  ])("leaves %j as words", (text) => {
    expect(rewriteSpokenCommand(text, claude)).toBeNull();
    expect(rewriteSpokenCommand(text, codex)).toBeNull();
  });

  it("ends a name where its arguments start", () => {
    const vocabulary = buildVoiceCommandVocabulary(
      [custom("claude", "/review"), custom("claude", "/review-force")],
      sourcesOf("claude")
    );
    expect(rewriteSpokenCommand("slash review --force", vocabulary)).toBe("/review --force");
    expect(rewriteSpokenCommand("slash review force", vocabulary)).toBe("/review-force");
  });

  it("says where the arguments it copied sit in the spoken and the written text", () => {
    for (const [spoken, args] of [
      ["Um, slash review the review notes", "the review notes"],
      ["  Slash review   the review notes ", "the review notes"],
      ["slash review", ""],
    ] as const) {
      const plan = planSpokenCommand(spoken, claude)!;
      expect(spoken.trimEnd().slice(plan.argsFrom)).toBe(args);
      expect(plan.text.slice(plan.argsAt)).toBe(args);
    }
    expect(planSpokenCommand("review the notes", claude)).toBeNull();
  });

  it("looks past a leading hesitation", () => {
    expect(rewriteSpokenCommand("Um, slash review the last commit", claude)).toBe(
      "/review the last commit"
    );
  });

  it("keeps a name two commands share as words", () => {
    const vocabulary = buildVoiceCommandVocabulary(
      [custom("claude", "/foo-bar"), custom("claude", "/foobar", { scope: "user" })],
      sourcesOf("claude")
    );
    expect(rewriteSpokenCommand("slash foo bar now", vocabulary)).toBeNull();
  });

  it("says a prefix the way its source declares", () => {
    const sources: readonly CompletionSourceConfig[] = [
      { ...sourcesOf("codex")[1]!, spokenPrefixes: ["skill"] },
    ];
    const vocabulary = buildVoiceCommandVocabulary(
      [custom("codex", "$github", { kind: "plugin" })],
      sources
    );
    expect(rewriteSpokenCommand("skill github open the PR", vocabulary)).toBe(
      "$github open the PR"
    );
    expect(rewriteSpokenCommand("dollar github open the PR", vocabulary)).toBeNull();
  });

  it("only writes commands the target has", () => {
    // `$` is Codex's; Claude Code has no prefix for it.
    expect(rewriteSpokenCommand("dollar plugin creator", claude)).toBeNull();
    expect(rewriteSpokenCommand("slash pr comments", codex)).toBeNull();
  });
});

describe("classifySpokenCommandOpening", () => {
  it.each([
    ["Slash.", "pending"],
    ["slash", "pending"],
    ["Um, slash", "pending"],
    ["/", "pending"],
    ["Forward", "pending"],
    ["Slash PR", "pending"],
    ["Slash compact.", "complete"],
    ["Slash review the last commit", "complete"],
    ["Slash the budget", "none"],
    ["Fix the bug", "none"],
    ["Um,", "none"],
    ["slash review --force", "complete"],
  ])("Claude Code: %j is %s", (spoken, opening) => {
    expect(classifySpokenCommandOpening(spoken, claude)).toBe(opening);
  });

  it("waits on a name a longer one still starts with, until words follow it", () => {
    const withLonger = buildVoiceCommandVocabulary(
      [...getBuiltinSlashCommands("claude"), custom("claude", "/compact-all")],
      sourcesOf("claude")
    );
    expect(classifySpokenCommandOpening("Slash compact", withLonger)).toBe("extendable");
    expect(classifySpokenCommandOpening("Slash compact the logs", withLonger)).toBe("complete");
    expect(classifySpokenCommandOpening("Slash compact", claude)).toBe("complete");
  });

  it("waits while the words after a name still spell out a longer one", () => {
    const withLonger = buildVoiceCommandVocabulary(
      [...getBuiltinSlashCommands("claude"), custom("claude", "/review-pr-comments")],
      sourcesOf("claude")
    );
    expect(classifySpokenCommandOpening("slash review PR", withLonger)).toBe("extendable");
    expect(classifySpokenCommandOpening("slash review PR comments", withLonger)).toBe("complete");
    expect(classifySpokenCommandOpening("slash review PR 123", withLonger)).toBe("complete");
  });

  it("waits on a prefix said in words for a codex skill", () => {
    expect(classifySpokenCommandOpening("Dollar plugin", codex)).toBe("pending");
    expect(classifySpokenCommandOpening("slash prompts colon", codex)).toBe("pending");
    expect(classifySpokenCommandOpening("Dollar plugin creator", codex)).toBe("complete");
  });

  it("finds nothing to wait for without commands", () => {
    expect(classifySpokenCommandOpening("Slash", EMPTY_VOICE_COMMAND_VOCABULARY)).toBe("none");
  });
});

describe("voiceCommandKeyterms", () => {
  it("lists names as they're said, the user's own first", () => {
    const terms = voiceCommandKeyterms(codex, 4);
    expect(terms).toHaveLength(4);
    expect(terms.slice(0, 3)).toEqual(["plugin creator", "github", "deploy"]);
  });

  it("respects the limit", () => {
    expect(voiceCommandKeyterms(claude, 0)).toEqual([]);
  });
});

describe("opensWithVoiceCommand", () => {
  it.each([
    ["/compact", true],
    ["  $plugin-creator on the repo", true],
    ["/prompts:deploy now", true],
    ["/etc/hosts is wrong", false],
    ["$PATH is empty", false],
    ["/ alone", false],
    ["fix it", false],
  ])("%j: %s", (text, expected) => {
    expect(opensWithVoiceCommand(text)).toBe(expected);
  });
});

describe("openingVoiceCommandToken", () => {
  it.each([
    ["/compact", "/compact"],
    ["  $plugin-creator on the repo", "$plugin-creator"],
    ["/prompts:deploy\nnow", "/prompts:deploy"],
    ["\n  /review the diff", "/review"],
    ["/caf\u00e9 order", "/caf\u00e9"],
    ["/cafe\u0301 order", "/cafe\u0301"],
    // The agent would read the punctuation as part of the name.
    ["/review, then ship it", null],
    ["/etc/hosts is wrong", null],
    ["$PATH is empty", null],
    ["/ alone", null],
    ["please /review it", null],
    ["", null],
  ])("%j: %s", (text, expected) => {
    expect(openingVoiceCommandToken(text)).toBe(expected);
  });
});
