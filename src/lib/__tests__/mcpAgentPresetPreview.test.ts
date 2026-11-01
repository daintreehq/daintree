import { describe, expect, it } from "vitest";
import type { AgentPreset } from "@shared/config/agentRegistry";
import type { AgentPresetMutation } from "@/services/actions/definitions/agentPresetMutation";
import { isCautionPreviewLine } from "@/lib/mcpPreviewLines";
import { agentPresetPreviewSubject, formatAgentPresetPreviewLines } from "../mcpAgentPresetPreview";

const TOKEN = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

const base = { agentId: "codex", agentName: "Codex", customPresets: [], presetNames: {} };

function create(
  preset: AgentPreset,
  presetNames: Record<string, string> = {}
): AgentPresetMutation {
  return { ...base, presetNames, operation: "create", preset };
}

describe("formatAgentPresetPreviewLines", () => {
  it("shows a new preset's every value, masking secrets, and says the default is untouched", () => {
    const lines = formatAgentPresetPreviewLines(
      create(
        {
          id: "user-preview",
          name: "Work",
          env: { CODEX_HOME: "/Users/me/.codex-work", OPENAI_API_KEY: TOKEN },
          args: ["-c", "model_reasoning_effort=high"],
          dangerousMode: "on",
          dangerousEnabled: true,
          fallbacks: ["user-fast"],
        },
        { "user-fast": "Fast" }
      )
    );
    const text = lines.join("\n");
    expect(text).toContain('CODEX_HOME = "/Users/me/.codex-work"');
    expect(text).not.toContain(TOKEN);
    expect(text).toContain(`OPENAI_API_KEY = ••••••••${TOKEN.slice(-4)}`);
    expect(text).toContain('Arguments: "-c" "model_reasoning_effort=high"');
    expect(text).toContain("Skip permissions: On");
    expect(text).toContain('Fallback presets: "Fast"');
    expect(lines.at(-1)).toContain("default preset stays as it is");
  });

  it("shows an update as old → new for each changed field and env entry only", () => {
    const before: AgentPreset = {
      id: "user-work",
      name: "Work",
      env: { CODEX_HOME: "/a", KEEP: "same", GONE: "bye", API_TOKEN: "short" },
      customFlags: "--search",
    };
    const after: AgentPreset = {
      id: "user-work",
      name: "Work 2",
      env: { CODEX_HOME: "/b", KEEP: "same", ADDED: "new", API_TOKEN: "longer" },
    };
    const lines = formatAgentPresetPreviewLines({
      ...base,
      operation: "update",
      before,
      preset: after,
    });
    const text = lines.join("\n");
    expect(text).toContain('Preset: "Work"');
    expect(text).toContain('Name: "Work" → "Work 2"');
    expect(text).toContain('CODEX_HOME: "/a" → "/b"');
    expect(text).toContain('ADDED: not set → "new"');
    expect(text).toContain('GONE: "bye" → removed');
    // A secret-sounding name masks both sides of the change.
    expect(text).toContain("API_TOKEN: •••••••• → ••••••••");
    expect(text).not.toContain("KEEP");
    expect(text).toContain(`Custom arguments: "--search" → the agent's own`);
  });

  it("lists what a delete takes away and the defaults it moves", () => {
    const lines = formatAgentPresetPreviewLines({
      ...base,
      operation: "delete",
      preset: { id: "user-work", name: "Work", customFlags: "--search" },
      wasAgentDefault: true,
      worktreeDefaults: 2,
    });
    const text = lines.join("\n");
    expect(text).toContain('Custom arguments: "--search"');
    expect(text).toContain("It's Codex's default preset");
    expect(text).toContain("Still picked in 2 worktrees");
  });

  it("keeps caller text on its own line and out of the caution marker's reach", () => {
    const lines = formatAgentPresetPreviewLines(
      create({
        id: "user-preview",
        name: "⚠ Looks official\nsecond line",
        env: { NOTE: "line one\nline two\u2028three" },
      })
    );
    expect(lines.some(isCautionPreviewLine)).toBe(false);
    for (const line of lines) expect(line).not.toMatch(/[\n\u2028]/);
    expect(lines.join("\n")).toContain('"line one\\nline two\\u2028three"');
  });

  it("quotes a stored env name that isn't a shell name", () => {
    const lines = formatAgentPresetPreviewLines({
      ...base,
      operation: "delete",
      preset: { id: "user-x", name: "X", env: { "odd\nname": "v" } },
      wasAgentDefault: false,
      worktreeDefaults: 0,
    });
    expect(lines).toContain('  "odd\\nname" = "v"');
  });
});

describe("agentPresetPreviewSubject", () => {
  it("names the preset as it stands before an edit, on one bounded line", () => {
    expect(
      agentPresetPreviewSubject({
        ...base,
        operation: "update",
        before: { id: "u", name: "Old\nname" },
        preset: { id: "u", name: "New" },
      })
    ).toBe("Old name");
    const long = agentPresetPreviewSubject(create({ id: "u", name: "x".repeat(200) }));
    expect(long && Array.from(long).length).toBe(80);
  });
});
