import { describe, expect, it } from "vitest";
import type { AgentPreset } from "@shared/config/agentRegistry";
import type { AgentPresetMutation } from "@/services/actions/definitions/agentPresetMutation";
import { isCautionPreviewLine } from "@/lib/mcpPreviewLines";
import { agentPresetPreviewSubject, formatAgentPresetPreviewLines } from "../mcpAgentPresetPreview";

const TOKEN = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const MASKED_TOKEN = `••••••••${TOKEN.slice(-4)}`;

const base = { agentId: "codex", agentName: "Codex", customPresets: [], presetNames: {} };

function create(
  preset: AgentPreset,
  presetNames: Record<string, string> = {}
): AgentPresetMutation {
  return { ...base, presetNames, operation: "create", preset };
}

function update(
  before: AgentPreset,
  preset: AgentPreset,
  presetNames: Record<string, string> = {}
): AgentPresetMutation {
  return { ...base, presetNames, operation: "update", before, preset };
}

function remove(
  preset: AgentPreset,
  wasAgentDefault: boolean,
  worktreeDefaults: number
): AgentPresetMutation {
  return { ...base, operation: "delete", preset, wasAgentDefault, worktreeDefaults };
}

describe("formatAgentPresetPreviewLines", () => {
  it("shows a new preset's every value, masking secrets, and says the default is untouched", () => {
    const lines = formatAgentPresetPreviewLines(
      create(
        {
          id: "user-preview",
          name: "Work",
          // A token under a name nothing would flag is still masked.
          env: { CODEX_HOME: "/Users/me/.codex-work", NOTE: TOKEN },
          args: ["-c", "model_reasoning_effort=high"],
          customFlags: "--search",
          dangerousMode: "on",
          dangerousEnabled: true,
          inlineMode: "off",
          displayTitle: "Work tab",
          color: "#3b82f6",
          fallbacks: ["user-fast"],
          fallbackOnRateLimit: true,
        },
        { "user-fast": "Fast" }
      )
    );
    expect(lines).toEqual([
      "Agent: Codex",
      'Name: "Work"',
      "Environment variables:",
      '  CODEX_HOME = "/Users/me/.codex-work"',
      `  NOTE = ${MASKED_TOKEN}`,
      'Arguments: "-c" "model_reasoning_effort=high"',
      'Custom arguments: "--search"',
      "Skip permissions: On",
      "Alt-screen mode: Alt screen",
      'Display title: "Work tab"',
      'Colour: "#3b82f6"',
      'Fallback presets: "Fast" (user-fast)',
      "Fall back on usage limits: On",
      "Codex's default preset stays as it is.",
    ]);
  });

  it("shows an update as old → new for each changed field and env entry only", () => {
    const before: AgentPreset = {
      id: "user-work",
      name: "Work",
      env: { CODEX_HOME: "/a", KEEP: "same", GONE: "bye", API_TOKEN: "short", NOTE: "plain" },
      customFlags: "--search",
      color: "#3b82f6",
      inlineMode: "on",
    };
    const after: AgentPreset = {
      id: "user-work",
      name: "Work 2",
      env: { CODEX_HOME: "/b", KEEP: "same", ADDED: "new", API_TOKEN: "longer", NOTE: TOKEN },
      color: "#3b82f6",
      inlineMode: "off",
      dangerousMode: "on",
    };
    const text = formatAgentPresetPreviewLines(update(before, after)).join("\n");
    expect(text).toContain('Preset: "Work"');
    expect(text).toContain('Name: "Work" → "Work 2"');
    expect(text).toContain('CODEX_HOME: "/a" → "/b"');
    expect(text).toContain('ADDED: not set → "new"');
    expect(text).toContain('GONE: "bye" → removed');
    // A secret-sounding name masks both sides of the change, and so does a
    // secret-looking value on either side.
    expect(text).toContain("API_TOKEN: •••••••• → ••••••••");
    expect(text).toContain(`NOTE: •••••••• → ${MASKED_TOKEN}`);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain(`Custom arguments: "--search" → the agent's own`);
    expect(text).toContain("Alt-screen mode: Inline → Alt screen");
    expect(text).toContain("Skip permissions: the agent's setting → On");
    expect(text).not.toContain("KEEP");
    expect(text).not.toContain("Colour");
  });

  it("shows a fallback swap between two presets sharing a name", () => {
    const names = { "user-a": "Fast", "user-b": "Fast" };
    const text = formatAgentPresetPreviewLines(
      update(
        { id: "user-work", name: "Work", fallbacks: ["user-a"] },
        { id: "user-work", name: "Work", fallbacks: ["user-b"] },
        names
      )
    ).join("\n");
    expect(text).toContain('Fallback presets: "Fast" (user-a) → "Fast" (user-b)');
  });

  it("lists what a delete takes away and the defaults it moves", () => {
    const preset: AgentPreset = { id: "user-work", name: "Work", customFlags: "--search" };
    const both = formatAgentPresetPreviewLines(remove(preset, true, 2)).join("\n");
    expect(both).toContain('Custom arguments: "--search"');
    expect(both).toContain("It's Codex's default preset");
    expect(both).toContain("Still picked in 2 worktrees");

    expect(formatAgentPresetPreviewLines(remove(preset, false, 1)).join("\n")).toContain(
      "Still picked in 1 worktree;"
    );
    const neither = formatAgentPresetPreviewLines(remove(preset, false, 0)).join("\n");
    expect(neither).not.toContain("default preset");
    expect(neither).not.toContain("Still picked");
  });

  it("keeps caller text on its own line and out of the caution marker's reach", () => {
    const lines = formatAgentPresetPreviewLines(
      create({
        id: "user-preview",
        name: "⚠ Looks official\nsecond line",
        env: { NOTE: "line one\nline two\u2028three\u2029four" },
      })
    );
    expect(lines.some(isCautionPreviewLine)).toBe(false);
    for (const line of lines) expect(line).not.toMatch(/[\n\u2028\u2029]/);
    expect(lines).toContain('Name: "⚠ Looks official\\nsecond line"');
    expect(lines).toContain('  NOTE = "line one\\nline two\\u2028three\\u2029four"');
  });

  it("quotes a stored env name that isn't a shell name", () => {
    const lines = formatAgentPresetPreviewLines(
      remove({ id: "user-x", name: "X", env: { "odd\nname": "v" } }, false, 0)
    );
    expect(lines).toContain('  "odd\\nname" = "v"');
  });

  it("previews a stored preset with no name instead of failing", () => {
    const nameless: AgentPreset = JSON.parse('{"id":"user-a","args":[1]}');
    const text = formatAgentPresetPreviewLines(
      update(nameless, { ...nameless, name: "Named" })
    ).join("\n");
    expect(text).toContain("Preset: none");
    expect(text).toContain('Name: none → "Named"');
  });
});

describe("agentPresetPreviewSubject", () => {
  it("names the preset as it stands before an edit, on one line", () => {
    expect(
      agentPresetPreviewSubject(update({ id: "u", name: "Old\nname" }, { id: "u", name: "New" }))
    ).toBe("Old name");
  });

  it("bounds a long name, keeping its start and saying it was cut", () => {
    const name = `${"ab".repeat(100)}🙂`;
    const subject = agentPresetPreviewSubject(create({ id: "u", name })) ?? "";
    expect(subject.endsWith("…")).toBe(true);
    expect(name.startsWith(subject.slice(0, -1))).toBe(true);
    expect(Array.from(subject).length).toBeLessThan(Array.from(name).length);
  });
});
