import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateAgentCommand } from "../agentSettings.js";
import {
  AGENT_REGISTRY,
  PROMPT_FORM_PLACEHOLDER,
  setUserRegistry,
} from "../../config/agentRegistry.js";
import type { AgentConfig } from "../../config/agentRegistry.js";
import {
  registerPluginAgents,
  clearPluginAgentRegistryForTests,
} from "../../config/pluginAgentRegistry.js";
import { BUILT_IN_AGENT_IDS } from "../../config/agentIds.js";
import { setAgentCommandDialectResolver } from "../../utils/shellEscape.js";
import type { GenerateAgentCommandOptions } from "../agentSettings.js";

const originalPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  setAgentCommandDialectResolver(null);
});

const LAUNCH_EXTRAS: GenerateAgentCommandOptions = {
  sessionId: "0b7c6c1e-8f0a-4c55-9d9e-3c1f4f7a2b10",
  modelId: "test-model",
  presetArgs: ["--preset-flag", "spaced preset value"],
};

function commandMatrix(agentId: string, dialect: "posix" | "windows"): Record<string, string> {
  setAgentCommandDialectResolver(() => dialect);
  const command = AGENT_REGISTRY[agentId as keyof typeof AGENT_REGISTRY].command;
  const run = (options: GenerateAgentCommandOptions) =>
    generateAgentCommand(command, {}, agentId, options);
  const rows: Record<string, string> = {};
  for (const interactive of [true, false]) {
    const mode = interactive ? "interactive" : "headless";
    if (dialect === "posix") {
      rows[`${mode}`] = run({ interactive });
      rows[`${mode} +extras`] = run({ interactive, ...LAUNCH_EXTRAS });
      rows[`${mode} +prompt`] = run({ interactive, initialPrompt: "Fix the bug" });
    }
    rows[`${mode} +prompt +extras`] = run({
      interactive,
      initialPrompt: "Fix the bug",
      ...LAUNCH_EXTRAS,
    });
  }
  return rows;
}

// Recorded from the per-agent `switch` that built the prompt part before the
// forms moved into the registry (#16367); any drift here is a launch change.
describe("built-in launch commands across prompt forms", () => {
  it("keeps every built-in agent's POSIX command unchanged", () => {
    const all = Object.fromEntries(
      BUILT_IN_AGENT_IDS.map((id) => [id, commandMatrix(id, "posix")])
    );
    expect(all).toMatchInlineSnapshot(`
      {
        "aider": {
          "headless": "aider --no-auto-commits",
          "headless +extras": "aider --no-auto-commits --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "aider --no-auto-commits -m 'Fix the bug'",
          "headless +prompt +extras": "aider --no-auto-commits --model test-model --preset-flag 'spaced preset value' -m 'Fix the bug'",
          "interactive": "aider --no-auto-commits",
          "interactive +extras": "aider --no-auto-commits --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "aider --no-auto-commits -m 'Fix the bug'",
          "interactive +prompt +extras": "aider --no-auto-commits --model test-model --preset-flag 'spaced preset value' -m 'Fix the bug'",
        },
        "amp": {
          "headless": "amp",
          "headless +extras": "amp --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "amp -x 'Fix the bug'",
          "headless +prompt +extras": "amp --model test-model --preset-flag 'spaced preset value' -x 'Fix the bug'",
          "interactive": "amp",
          "interactive +extras": "amp --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "amp 'Fix the bug'",
          "interactive +prompt +extras": "amp --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "antigravity": {
          "headless": "agy",
          "headless +extras": "agy --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "agy -p 'Fix the bug'",
          "headless +prompt +extras": "agy --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive": "agy",
          "interactive +extras": "agy --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "agy -i 'Fix the bug'",
          "interactive +prompt +extras": "agy --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
        "claude": {
          "headless": "claude",
          "headless +extras": "claude --session-id '0b7c6c1e-8f0a-4c55-9d9e-3c1f4f7a2b10' --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "claude -p 'Fix the bug'",
          "headless +prompt +extras": "claude --session-id '0b7c6c1e-8f0a-4c55-9d9e-3c1f4f7a2b10' --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive": "claude",
          "interactive +extras": "claude --session-id '0b7c6c1e-8f0a-4c55-9d9e-3c1f4f7a2b10' --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "claude 'Fix the bug'",
          "interactive +prompt +extras": "claude --session-id '0b7c6c1e-8f0a-4c55-9d9e-3c1f4f7a2b10' --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "codex": {
          "headless": "codex -c 'tui.whimsy=false'",
          "headless +extras": "codex --model test-model --preset-flag 'spaced preset value' -c 'tui.whimsy=false'",
          "headless +prompt": "codex -c 'tui.whimsy=false' exec 'Fix the bug'",
          "headless +prompt +extras": "codex --model test-model --preset-flag 'spaced preset value' -c 'tui.whimsy=false' exec 'Fix the bug'",
          "interactive": "codex --no-alt-screen -c 'tui.whimsy=false'",
          "interactive +extras": "codex --no-alt-screen --model test-model --preset-flag 'spaced preset value' -c 'tui.whimsy=false'",
          "interactive +prompt": "codex --no-alt-screen -c 'tui.whimsy=false' 'Fix the bug'",
          "interactive +prompt +extras": "codex --no-alt-screen --model test-model --preset-flag 'spaced preset value' -c 'tui.whimsy=false' 'Fix the bug'",
        },
        "copilot": {
          "headless": "copilot",
          "headless +extras": "copilot --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "copilot -p 'Fix the bug'",
          "headless +prompt +extras": "copilot --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive": "copilot",
          "interactive +extras": "copilot --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "copilot -i 'Fix the bug'",
          "interactive +prompt +extras": "copilot --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
        "crush": {
          "headless": "crush",
          "headless +extras": "crush --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "crush run 'Fix the bug'",
          "headless +prompt +extras": "crush --model test-model --preset-flag 'spaced preset value' run 'Fix the bug'",
          "interactive": "crush",
          "interactive +extras": "crush --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "crush 'Fix the bug'",
          "interactive +prompt +extras": "crush --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "cursor": {
          "headless": "cursor-agent",
          "headless +extras": "cursor-agent --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "cursor-agent 'Fix the bug'",
          "headless +prompt +extras": "cursor-agent --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
          "interactive": "cursor-agent",
          "interactive +extras": "cursor-agent --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "cursor-agent 'Fix the bug'",
          "interactive +prompt +extras": "cursor-agent --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "gemini": {
          "headless": "gemini",
          "headless +extras": "gemini --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "gemini -p 'Fix the bug'",
          "headless +prompt +extras": "gemini --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive": "gemini",
          "interactive +extras": "gemini --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "gemini -i 'Fix the bug'",
          "interactive +prompt +extras": "gemini --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
        "goose": {
          "headless": "goose 'session'",
          "headless +extras": "goose 'session' --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "goose run -t 'Fix the bug'",
          "headless +prompt +extras": "goose run --model test-model --preset-flag 'spaced preset value' -t 'Fix the bug'",
          "interactive": "goose 'session'",
          "interactive +extras": "goose 'session' --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "goose run -t 'Fix the bug' --interactive",
          "interactive +prompt +extras": "goose run --model test-model --preset-flag 'spaced preset value' -t 'Fix the bug' --interactive",
        },
        "grok": {
          "headless": "grok",
          "headless +extras": "grok --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "grok -p 'Fix the bug'",
          "headless +prompt +extras": "grok --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive": "grok --no-alt-screen",
          "interactive +extras": "grok --no-alt-screen --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "grok --no-alt-screen 'Fix the bug'",
          "interactive +prompt +extras": "grok --no-alt-screen --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "interpreter": {
          "headless": "interpreter",
          "headless +extras": "interpreter --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "interpreter 'Fix the bug'",
          "headless +prompt +extras": "interpreter --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
          "interactive": "interpreter",
          "interactive +extras": "interpreter --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "interpreter 'Fix the bug'",
          "interactive +prompt +extras": "interpreter --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "kimi": {
          "headless": "kimi",
          "headless +extras": "kimi --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "kimi -p 'Fix the bug'",
          "headless +prompt +extras": "kimi --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive": "kimi",
          "interactive +extras": "kimi --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "kimi -p 'Fix the bug'",
          "interactive +prompt +extras": "kimi --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
        },
        "kiro": {
          "headless": "kiro-cli",
          "headless +extras": "kiro-cli --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "kiro-cli chat --no-interactive 'Fix the bug'",
          "headless +prompt +extras": "kiro-cli --model test-model --preset-flag 'spaced preset value' chat --no-interactive 'Fix the bug'",
          "interactive": "kiro-cli",
          "interactive +extras": "kiro-cli --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "kiro-cli 'Fix the bug'",
          "interactive +prompt +extras": "kiro-cli --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "mistral": {
          "headless": "vibe --trust",
          "headless +extras": "vibe --trust --preset-flag 'spaced preset value'",
          "headless +prompt": "vibe --trust --prompt 'Fix the bug'",
          "headless +prompt +extras": "vibe --trust --model test-model --preset-flag 'spaced preset value' --prompt 'Fix the bug'",
          "interactive": "vibe --trust",
          "interactive +extras": "vibe --trust --preset-flag 'spaced preset value'",
          "interactive +prompt": "vibe --trust 'Fix the bug'",
          "interactive +prompt +extras": "vibe --trust --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "opencode": {
          "headless": "opencode",
          "headless +extras": "opencode --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "opencode run 'Fix the bug'",
          "headless +prompt +extras": "opencode --model test-model --preset-flag 'spaced preset value' run 'Fix the bug'",
          "interactive": "opencode --mini",
          "interactive +extras": "opencode --mini --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "opencode --mini --prompt 'Fix the bug'",
          "interactive +prompt +extras": "opencode --mini --model test-model --preset-flag 'spaced preset value' --prompt 'Fix the bug'",
        },
        "qwen": {
          "headless": "qwen",
          "headless +extras": "qwen --model test-model --preset-flag 'spaced preset value'",
          "headless +prompt": "qwen -p 'Fix the bug'",
          "headless +prompt +extras": "qwen --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive": "qwen",
          "interactive +extras": "qwen --model test-model --preset-flag 'spaced preset value'",
          "interactive +prompt": "qwen -i 'Fix the bug'",
          "interactive +prompt +extras": "qwen --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
      }
    `);
  });

  it("keeps every built-in agent's PowerShell command unchanged", () => {
    const all = Object.fromEntries(
      BUILT_IN_AGENT_IDS.map((id) => [id, commandMatrix(id, "windows")])
    );
    expect(all).toMatchInlineSnapshot(`
      {
        "aider": {
          "headless +prompt +extras": "aider --no-auto-commits --model test-model --preset-flag 'spaced preset value' -m 'Fix the bug'",
          "interactive +prompt +extras": "aider --no-auto-commits --model test-model --preset-flag 'spaced preset value' -m 'Fix the bug'",
        },
        "amp": {
          "headless +prompt +extras": "amp --model test-model --preset-flag 'spaced preset value' -x 'Fix the bug'",
          "interactive +prompt +extras": "amp --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "antigravity": {
          "headless +prompt +extras": "agy --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive +prompt +extras": "agy --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
        "claude": {
          "headless +prompt +extras": "claude --session-id '0b7c6c1e-8f0a-4c55-9d9e-3c1f4f7a2b10' --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive +prompt +extras": "claude --session-id '0b7c6c1e-8f0a-4c55-9d9e-3c1f4f7a2b10' --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "codex": {
          "headless +prompt +extras": "codex --model test-model --preset-flag 'spaced preset value' -c 'tui.whimsy=false' exec 'Fix the bug'",
          "interactive +prompt +extras": "codex --no-alt-screen --model test-model --preset-flag 'spaced preset value' -c 'tui.whimsy=false' 'Fix the bug'",
        },
        "copilot": {
          "headless +prompt +extras": "copilot --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive +prompt +extras": "copilot --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
        "crush": {
          "headless +prompt +extras": "crush --model test-model --preset-flag 'spaced preset value' run 'Fix the bug'",
          "interactive +prompt +extras": "crush --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "cursor": {
          "headless +prompt +extras": "cursor-agent --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
          "interactive +prompt +extras": "cursor-agent --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "gemini": {
          "headless +prompt +extras": "gemini --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive +prompt +extras": "gemini --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
        "goose": {
          "headless +prompt +extras": "goose run --model test-model --preset-flag 'spaced preset value' -t 'Fix the bug'",
          "interactive +prompt +extras": "goose run --model test-model --preset-flag 'spaced preset value' -t 'Fix the bug' --interactive",
        },
        "grok": {
          "headless +prompt +extras": "grok --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive +prompt +extras": "grok --no-alt-screen --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "interpreter": {
          "headless +prompt +extras": "interpreter --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
          "interactive +prompt +extras": "interpreter --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "kimi": {
          "headless +prompt +extras": "kimi --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive +prompt +extras": "kimi --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
        },
        "kiro": {
          "headless +prompt +extras": "kiro-cli --model test-model --preset-flag 'spaced preset value' chat --no-interactive 'Fix the bug'",
          "interactive +prompt +extras": "kiro-cli --model test-model --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "mistral": {
          "headless +prompt +extras": "vibe --trust --model test-model --preset-flag 'spaced preset value' --prompt 'Fix the bug'",
          "interactive +prompt +extras": "vibe --trust --preset-flag 'spaced preset value' 'Fix the bug'",
        },
        "opencode": {
          "headless +prompt +extras": "opencode --model test-model --preset-flag 'spaced preset value' run 'Fix the bug'",
          "interactive +prompt +extras": "opencode --mini --model test-model --preset-flag 'spaced preset value' --prompt 'Fix the bug'",
        },
        "qwen": {
          "headless +prompt +extras": "qwen --model test-model --preset-flag 'spaced preset value' -p 'Fix the bug'",
          "interactive +prompt +extras": "qwen --model test-model --preset-flag 'spaced preset value' -i 'Fix the bug'",
        },
      }
    `);
  });
});

describe("built-in prompt form declarations", () => {
  it("carry the prompt as exactly one whole argument in every declared form", () => {
    for (const config of Object.values(AGENT_REGISTRY)) {
      for (const form of Object.values(config.initialPromptForm ?? {})) {
        const whole = form.args.filter((arg) => arg === PROMPT_FORM_PLACEHOLDER);
        const embedded = form.args.filter(
          (arg) => arg !== PROMPT_FORM_PLACEHOLDER && arg.includes(PROMPT_FORM_PLACEHOLDER)
        );
        expect({ agent: config.id, whole: whole.length, embedded }).toEqual({
          agent: config.id,
          whole: 1,
          embedded: [],
        });
      }
    }
  });
});

describe("agents that declare no prompt form", () => {
  afterEach(() => {
    clearPluginAgentRegistryForTests();
    setUserRegistry({});
  });

  const agentBase = { name: "Agent", color: "#3366ff", iconId: "terminal" };

  it("hand a plugin agent the prompt positionally in both modes", () => {
    registerPluginAgents("me.extra-agents", [
      { ...agentBase, id: "pi", command: "pi", args: ["--profile", "work"] },
    ]);
    for (const interactive of [true, false]) {
      expect(generateAgentCommand("pi", {}, "pi", { interactive, initialPrompt: "Fix it" })).toBe(
        "pi --profile 'work' 'Fix it'"
      );
    }
  });

  it("hand a user agent, an unknown agent and an unnamed one the prompt positionally", () => {
    setUserRegistry({
      mine: { ...agentBase, id: "mine", command: "mine", supportsContextInjection: false },
    });
    expect(generateAgentCommand("mine", {}, "mine", { initialPrompt: "Fix it" })).toBe(
      "mine 'Fix it'"
    );
    expect(
      generateAgentCommand("ghost", {}, "ghost", { interactive: false, initialPrompt: "Fix it" })
    ).toBe("ghost 'Fix it'");
    expect(generateAgentCommand("tool", {}, undefined, { initialPrompt: "Fix it" })).toBe(
      "tool 'Fix it'"
    );
  });
});

describe("a declared prompt form", () => {
  afterEach(() => setUserRegistry({}));

  function declare(config: Partial<AgentConfig>): void {
    setUserRegistry({
      task: {
        id: "task",
        name: "Task",
        command: "task",
        color: "#3366ff",
        iconId: "terminal",
        supportsContextInjection: false,
        ...config,
      },
    });
  }

  it("quotes a declared word the shell would split, keeping the prompt one argument", () => {
    declare({
      initialPromptForm: {
        interactive: { args: ["--task", PROMPT_FORM_PLACEHOLDER, "--mode", "fast; rm -rf"] },
        headless: { args: ["--print", PROMPT_FORM_PLACEHOLDER] },
      },
    });
    expect(generateAgentCommand("task", {}, "task", { initialPrompt: "-n it's broken" })).toBe(
      "task --task '-n it'\\''s broken' --mode 'fast; rm -rf'"
    );
    expect(
      generateAgentCommand("task", {}, "task", { interactive: false, initialPrompt: "Fix it" })
    ).toBe("task --print 'Fix it'");
  });

  it("swaps a registry subcommand only where the registry carries it", () => {
    const form = {
      subcommand: { name: "run", replaces: "session" },
      args: ["-t", PROMPT_FORM_PLACEHOLDER],
    };
    declare({
      args: ["session", "--verbose"],
      initialPromptForm: { interactive: form, headless: form },
    });
    expect(generateAgentCommand("task", {}, "task", { initialPrompt: "Fix it" })).toBe(
      "task run --verbose -t 'Fix it'"
    );

    // The same word in a preset is that preset's value, not the subcommand.
    declare({ args: ["--verbose"], initialPromptForm: { interactive: form, headless: form } });
    expect(
      generateAgentCommand("task", {}, "task", {
        initialPrompt: "Fix it",
        presetArgs: ["--name", "session"],
      })
    ).toBe("task run --verbose --name 'session' -t 'Fix it'");
  });

  it("applies nothing to a launch without a prompt", () => {
    for (const initialPrompt of [undefined, "", "   "]) {
      expect(generateAgentCommand("goose", {}, "goose", { initialPrompt })).toBe("goose 'session'");
    }
  });
});
