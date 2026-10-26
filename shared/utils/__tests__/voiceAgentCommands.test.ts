import { describe, expect, it } from "vitest";
import { getAgentConfig } from "../../config/agentRegistry.js";
import { getBuiltinSlashCommands, type SlashCommand } from "../../types/slashCommands.js";
import type { CompletionSourceConfig } from "../../types/completionSources.js";
import {
  buildVoiceCommandVocabulary,
  checkVoiceCommandEdit,
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

  it("only writes commands the target has", () => {
    // `$` is Codex's; Claude Code has no prefix for it.
    expect(rewriteSpokenCommand("dollar plugin creator", claude)).toBeNull();
    expect(rewriteSpokenCommand("slash pr comments", codex)).toBeNull();
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

describe("checkVoiceCommandEdit", () => {
  it("lets correction write an implied command at the start of the prompt", () => {
    expect(
      checkVoiceCommandEdit(
        "run the review skill on the auth module",
        "/review on the auth module",
        claude,
        true
      )
    ).toBeNull();
    expect(
      checkVoiceCommandEdit("compact the conversation", "/compact", claude, true)
    ).toBeNull();
    expect(
      checkVoiceCommandEdit("use the plugin creator for a linter", "$plugin-creator for a linter", codex, true)
    ).toBeNull();
  });

  it("rejects a command the target doesn't have", () => {
    expect(checkVoiceCommandEdit("run the deploy skill", "/deploy", claude, true)).toBe(
      "unknown_command"
    );
    expect(checkVoiceCommandEdit("compact it", "/compact.", claude, true)).toBe(
      "unknown_command"
    );
  });

  it("rejects a command introduced anywhere but the start of the prompt", () => {
    expect(checkVoiceCommandEdit("compact the conversation", "/compact", claude, false)).toBe(
      "unprompted_command"
    );
  });

  it("rejects a command the dictation never named", () => {
    expect(checkVoiceCommandEdit("tidy things up a bit", "/compact", claude, true)).toBe(
      "unprompted_command"
    );
  });

  it("keeps a leading command and its arguments' formatting", () => {
    expect(
      checkVoiceCommandEdit("/review um the last commit", "/review the last commit", claude, true)
    ).toBeNull();
    expect(
      checkVoiceCommandEdit("/review the last commit", "/pr-comments the last commit", claude, true)
    ).toBe("command_changed");
    expect(
      checkVoiceCommandEdit("/review the last commit", "/review The last commit.", claude, true)
    ).toBe("arguments_reformatted");
    expect(
      checkVoiceCommandEdit("$github open the pr", "$github open the PR", codex, true)
    ).toBe("arguments_reformatted");
  });

  it("leaves paths and ordinary text to the other guards", () => {
    expect(
      checkVoiceCommandEdit("slash etc slash hosts is wrong", "/etc/hosts is wrong", claude, true)
    ).toBeNull();
    expect(
      checkVoiceCommandEdit("the review was good", "The review was good.", claude, true)
    ).toBeNull();
  });

  // Ordinary sentences that mention command words: a cleanup that turned any
  // of them into a command it wasn't asked for is caught when it isn't at the
  // start, or names nothing the dictation said.
  it.each([
    ["we should review the last commit later", "/review the last commit later", false],
    ["the compact layout looks off", "/compact layout looks off", false],
    ["i like that plugin creator idea", "$plugin-creator idea", false],
  ])("catches %j turned into a command mid-prompt", (raw, corrected, startsPrompt) => {
    const vocabulary = corrected.startsWith("$") ? codex : claude;
    expect(checkVoiceCommandEdit(raw, corrected, vocabulary, startsPrompt)).toBe(
      "unprompted_command"
    );
  });
});
