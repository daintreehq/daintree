import { describe, expect, it } from "vitest";
import { getAgentConfig } from "../../config/agentRegistry.js";
import { getBuiltinSlashCommands, type SlashCommand } from "../../types/slashCommands.js";
import type { CompletionSourceConfig } from "../../types/completionSources.js";
import {
  buildVoiceCommandVocabulary,
  checkVoiceCommandEdit,
  introducesVoiceCommand,
  opensWithVoiceCommand,
  planSpokenCommand,
  rewriteSpokenCommand,
  voiceCommandBaseline,
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
    expect(checkVoiceCommandEdit("run the compact command", "/compact", claude, true)).toBeNull();
    expect(
      checkVoiceCommandEdit(
        "use the plugin creator for a linter",
        "$plugin-creator for a linter",
        codex,
        true
      )
    ).toBeNull();
  });

  it("rejects a command the target doesn't have", () => {
    expect(checkVoiceCommandEdit("run the deploy skill", "/deploy", claude, true)).toBe(
      "unknown_command"
    );
    expect(checkVoiceCommandEdit("compact it", "/compact.", claude, true)).toBe("unknown_command");
  });

  it("rejects a command introduced anywhere but the start of the prompt", () => {
    expect(checkVoiceCommandEdit("run the compact command", "/compact", claude, false)).toBe(
      "unprompted_command"
    );
  });

  it("rejects a command the dictation never asked for", () => {
    expect(checkVoiceCommandEdit("tidy things up a bit", "/compact", claude, true)).toBe(
      "unprompted_command"
    );
  });

  it("accepts a command said with its trigger after a hesitation", () => {
    expect(
      checkVoiceCommandEdit(
        "um slash review the last commit",
        "/review the last commit",
        claude,
        true
      )
    ).toBeNull();
  });

  it("measures the rest of a polite request against the command it became", () => {
    const raw = "can you please run the review skill on auth";
    expect(checkVoiceCommandEdit(raw, "/review on auth", claude, true)).toBeNull();
    expect(voiceCommandBaseline(raw, "/review on auth", claude)).toBe("/review on auth");
    expect(voiceCommandBaseline("the review was good", "/review was good", claude)).toBeNull();
  });

  it("rejects a command with punctuation stuck to it", () => {
    expect(checkVoiceCommandEdit("run the deploy skill", "/deploy!", claude, true)).toBe(
      "unknown_command"
    );
    expect(checkVoiceCommandEdit("run the compact command", "/compact!", claude, true)).toBe(
      "unknown_command"
    );
  });

  it("leaves shell variables to the other guards", () => {
    expect(
      checkVoiceCommandEdit("dollar sign PATH is empty", "$PATH is empty.", claude, true)
    ).toBeNull();
  });

  it("keeps 'slash' and a name the target hasn't got as words, even for a path", () => {
    expect(
      checkVoiceCommandEdit("slash tmp contains logs", "/tmp contains logs.", claude, true)
    ).toBe("unknown_command");
  });

  it("never reads a flag as part of an implied command's name", () => {
    const vocabulary = buildVoiceCommandVocabulary(
      [custom("claude", "/review"), custom("claude", "/review-force")],
      sourcesOf("claude")
    );
    expect(
      checkVoiceCommandEdit("run the review --force", "/review-force", vocabulary, true)
    ).not.toBeNull();
    expect(
      checkVoiceCommandEdit("run the review --force", "/review --force", vocabulary, true)
    ).toBeNull();
  });

  it("keeps an introduced command's arguments as said, but for the closing period", () => {
    expect(
      checkVoiceCommandEdit("run the review skill on API", "/review on api.", claude, true)
    ).toBe("arguments_reformatted");
    expect(
      checkVoiceCommandEdit("Run the review skill on the API.", "/review on the API", claude, true)
    ).toBeNull();
  });

  it("rejects an introduced command that drops or rewrites what followed it", () => {
    expect(
      checkVoiceCommandEdit(
        "run the review skill on the auth module",
        "/review on billing",
        claude,
        true
      )
    ).toBe("arguments_reformatted");
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
    expect(checkVoiceCommandEdit("$github open the pr", "$github open the PR", codex, true)).toBe(
      "arguments_reformatted"
    );
    expect(
      checkVoiceCommandEdit("/review security and billing", "/review billing", claude, true)
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

  // Ordinary sentences that mention command words, at the start of a prompt:
  // a cleanup that turned any of them into a command is thrown out, including
  // a sentence that opens with a bare command name ("compact cars use less
  // space"), which only a spoken trigger or a verb like "run" turns into one.
  it.each([
    ["the review skill is broken", "/review is broken"],
    ["we should review the last commit later", "/review the last commit later"],
    ["explain the compact command", "/compact"],
    ["don't compact the conversation", "/compact the conversation"],
    ["compact cars use less space", "/compact cars use less space"],
    ["compact the conversation", "/compact"],
    ["the compact layout looks off", "/compact layout looks off"],
    ["i like that plugin creator idea", "$plugin-creator idea"],
    ["can you review how the github plugin works", "$github plugin works"],
  ])("leaves %j as prose", (raw, corrected) => {
    const vocabulary = corrected.startsWith("$") ? codex : claude;
    expect(checkVoiceCommandEdit(raw, corrected, vocabulary, true)).not.toBeNull();
  });
});

describe("a bare imperative that shares a command's name", () => {
  const catalogAgents = ["claude", "codex", "gemini"] as const;
  const vocabularyOf = (agentId: (typeof catalogAgents)[number]) =>
    buildVoiceCommandVocabulary(
      getBuiltinSlashCommands(agentId),
      getAgentConfig(agentId)!.completionSources!
    );

  // The rule only fires for a command the target has; one it lacks is turned away
  // as unknown, so each pair names the reason it's rejected for.
  it.each([
    [
      "Delete the unused imports in the auth module",
      "/delete",
      "unknown_command",
      "unprompted_command",
    ],
    ["Archive the old release branches", "/archive", "unknown_command", "unprompted_command"],
    ["Clear the build cache and rebuild", "/clear", "unprompted_command", "unprompted_command"],
    [
      "Rewind the migration before you change it",
      "/rewind",
      "unprompted_command",
      "unknown_command",
    ],
  ])("stays prose in Claude and Codex: %j", (raw, command, inClaude, inCodex) => {
    const rest = raw.split(" ").slice(1).join(" ").trim();
    const corrected = `${command} ${rest}`;
    expect(checkVoiceCommandEdit(raw, corrected, claude, true)).toBe(inClaude);
    expect(checkVoiceCommandEdit(raw, corrected, codex, true)).toBe(inCodex);
  });

  it("stays prose whatever shape the model returns", () => {
    const raw = "Clear the build cache and rebuild";
    expect(checkVoiceCommandEdit(raw, "/clear", claude, true)).toBe("unprompted_command");
    expect(checkVoiceCommandEdit(raw, "/compact the build cache", claude, true)).toBe(
      "unprompted_command"
    );
    expect(checkVoiceCommandEdit(raw, "/clear the build cache and rebuild.", claude, true)).toBe(
      "unprompted_command"
    );
  });

  it("never becomes any built-in command of an agent that has a catalog", () => {
    const collisions: string[] = [];
    for (const agentId of catalogAgents) {
      const vocabulary = vocabularyOf(agentId);
      expect(vocabulary.entries.length).toBeGreaterThan(20);
      for (const entry of vocabulary.entries) {
        const tail = "the build cache and rebuild";
        const corrected = `${entry.token} ${tail}`;
        // The positive control: the same name, said after a verb that runs it, is accepted.
        const asked = checkVoiceCommandEdit(
          `Run ${entry.spokenName} ${tail}`,
          corrected,
          vocabulary,
          true
        );
        const bare = checkVoiceCommandEdit(
          `${entry.spokenName} ${tail}`,
          corrected,
          vocabulary,
          true
        );
        if (asked !== null || bare !== "unprompted_command") {
          collisions.push(`${agentId} ${entry.token}: asked=${asked} bare=${bare}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it.each([
    ["Please clear the build cache", "/clear the build cache"],
    ["Can you clear the build cache", "/clear the build cache"],
    ["Go clear the build cache", "/clear the build cache"],
    ["Now rewind the migration", "/rewind the migration"],
    ["Um, clear the build cache", "/clear the build cache"],
    ["Clear command history", "/clear history"],
    ["Clear", "/clear"],
    ["Review the last commit", "/review the last commit"],
    ["Ship it", "/ship-it"],
    ["Frontend component for the header", "/frontend:component for the header"],
  ])("stays prose with nothing that runs a command before it: %j", (raw, corrected) => {
    expect(checkVoiceCommandEdit(raw, corrected, claude, true)).toBe("unprompted_command");
    expect(voiceCommandBaseline(raw, corrected, claude)).toBeNull();
  });

  it.each([
    ["Plugin creator for a linter", "$plugin-creator for a linter"],
    ["GitHub open the PR", "$github open the PR"],
  ])("stays prose for a Codex skill or plugin: %j", (raw, corrected) => {
    expect(checkVoiceCommandEdit(raw, corrected, codex, true)).toBe("unprompted_command");
  });

  it("holds a skill named in capitals to the same rule as a shell variable it resembles", () => {
    const shouting = buildVoiceCommandVocabulary(
      [custom("codex", "$README", { kind: "skill" })],
      sourcesOf("codex")
    );
    expect(checkVoiceCommandEdit("Readme the repo", "$README the repo", shouting, true)).toBe(
      "unprompted_command"
    );
    expect(
      checkVoiceCommandEdit(
        "Run the readme skill on the repo",
        "$README on the repo",
        shouting,
        true
      )
    ).toBeNull();
    expect(
      checkVoiceCommandEdit("dollar PATH is empty", "$PATH is empty.", shouting, true)
    ).toBeNull();
  });

  it("is still a command when the dictation spoke its trigger or a lead-in", () => {
    expect(
      checkVoiceCommandEdit("Slash clear the build cache", "/clear the build cache", claude, true)
    ).toBeNull();
    expect(checkVoiceCommandEdit("Run clear", "/clear", claude, true)).toBeNull();
    expect(voiceCommandBaseline("Run clear", "/clear", claude)).toBe("/clear");
    expect(
      checkVoiceCommandEdit(
        "Please run archive on the old release branches",
        "/archive on the old release branches",
        codex,
        true
      )
    ).toBeNull();
    expect(
      voiceCommandBaseline(
        "Please run archive on the old release branches",
        "/archive on the old release branches",
        codex
      )
    ).toBe("/archive on the old release branches");
    expect(
      voiceCommandBaseline("Slash clear the build cache", "/clear the build cache", claude)
    ).toBe("/clear the build cache");
  });
});

describe("introducesVoiceCommand", () => {
  it.each([
    ["compact the conversation", "/compact", true],
    ["use plugin creator", "$plugin-creator", true],
    ["/review the commit", "/review the commit", false],
    ["slash etc slash hosts is wrong", "/etc/hosts is wrong", false],
    ["dollar home is unset", "$HOME is unset", false],
    ["hello", "Hello.", false],
  ])("%j → %j: %s", (raw, corrected, expected) => {
    expect(introducesVoiceCommand(raw, corrected)).toBe(expected);
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
