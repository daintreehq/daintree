import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migration042 } from "../042-interpreter-bypass-flag.js";
import { DEFAULT_DANGEROUS_ARGS } from "../../../../shared/types/agentSettings.js";

function run(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => structuredClone(data[key])),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration042.up>[0];
  migration042.up(store);
  return { data, store };
}

describe("migration042 — Open Interpreter's retired bypass flag", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swaps the stored Python default for the flag the current CLI accepts", () => {
    const { data } = run({
      agentSettings: {
        globalSkipPermissions: true,
        agents: {
          interpreter: { customFlags: "-m o4", dangerousArgs: "--auto_run", dangerousMode: "on" },
          claude: { dangerousArgs: "--dangerously-skip-permissions" },
          // A custom agent may legitimately take the same spelling.
          "my-agent": { dangerousArgs: "--auto_run", dangerousMode: "on" },
        },
      },
    });

    expect(data.agentSettings).toEqual({
      globalSkipPermissions: true,
      agents: {
        interpreter: {
          customFlags: "-m o4",
          dangerousArgs: DEFAULT_DANGEROUS_ARGS.interpreter,
          dangerousMode: "on",
        },
        claude: { dangerousArgs: "--dangerously-skip-permissions" },
        "my-agent": { dangerousArgs: "--auto_run", dangerousMode: "on" },
      },
    });
  });

  it.each([
    ["a flag the user wrote", { dangerousArgs: "--auto_run --verbose" }],
    ["an empty value", { dangerousArgs: "" }],
    ["no value", { customFlags: "" }],
    ["a non-string value", { dangerousArgs: 7 }],
  ])("leaves %s alone", (_label, interpreter) => {
    const { store } = run({ agentSettings: { agents: { interpreter } } });
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each([
    ["no agent settings", {}],
    ["agent settings without agents", { agentSettings: { globalSkipPermissions: false } }],
    ["no interpreter entry", { agentSettings: { agents: { claude: {} } } }],
    ["a malformed interpreter entry", { agentSettings: { agents: { interpreter: "x" } } }],
    ["null agent settings", { agentSettings: null }],
    ["null agents", { agentSettings: { agents: null } }],
    ["a null interpreter entry", { agentSettings: { agents: { interpreter: null } } }],
  ])("does nothing with %s", (_label, initial) => {
    const { store } = run(initial);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("is a no-op when replayed", () => {
    const first = run({
      agentSettings: { agents: { interpreter: { dangerousArgs: "--auto_run" } } },
    });
    const second = run(first.data);
    expect(second.store.set).not.toHaveBeenCalled();
    expect(second.data).toEqual(first.data);
  });
});
