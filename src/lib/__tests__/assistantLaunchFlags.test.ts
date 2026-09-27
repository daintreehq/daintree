import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { loadCustomLaunchFlags } from "../assistantLaunchFlags";

const getSettings = vi.fn();
const getResolvedModelList = vi.fn();

function catalog(agentId: string, ids: string[]) {
  return {
    agentId,
    models: ids.map((id) => ({ id, name: id, shortLabel: id })),
    contextWindow: null,
    source: "merged",
  };
}

beforeEach(() => {
  getSettings.mockReset();
  getResolvedModelList.mockReset();
  getResolvedModelList.mockImplementation((agentId: string) =>
    Promise.resolve(
      agentId === "codex"
        ? catalog("codex", ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])
        : catalog(agentId, ["opus", "sonnet"])
    )
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      electron: {
        helpAssistant: { getSettings },
        agentCapabilities: { getResolvedModelList },
      },
    },
  });
});

describe("loadCustomLaunchFlags — model + custom args composition", () => {
  it("returns no flags for an explicit CLI default and no custom args", async () => {
    getSettings.mockResolvedValue({ modelIds: { claude: "" }, customArgs: "" });
    expect(await loadCustomLaunchFlags("claude")).toEqual([]);
  });

  it("injects --model when modelId is set", async () => {
    getSettings.mockResolvedValue({ modelIds: { claude: "claude-sonnet-4-6" }, customArgs: "" });
    expect(await loadCustomLaunchFlags("claude")).toEqual(["--model", "claude-sonnet-4-6"]);
  });

  it("prepends the model flag before custom args so a custom --model wins (last-flag semantics)", async () => {
    getSettings.mockResolvedValue({
      modelIds: { claude: "sonnet" },
      customArgs: "--model opus --verbose",
    });
    expect(await loadCustomLaunchFlags("claude")).toEqual([
      "--model",
      "sonnet",
      "--model",
      "opus",
      "--verbose",
    ]);
  });

  it("returns only custom args when the CLI default is chosen", async () => {
    getSettings.mockResolvedValue({ modelIds: { claude: "" }, customArgs: "--verbose --foo bar" });
    expect(await loadCustomLaunchFlags("claude")).toEqual(["--verbose", "--foo", "bar"]);
  });

  it("uses the agent's recommended model when no model is saved", async () => {
    getSettings.mockResolvedValue({ modelIds: {}, customArgs: "--verbose" });
    expect(await loadCustomLaunchFlags("claude")).toEqual(["--model", "sonnet", "--verbose"]);
    expect(await loadCustomLaunchFlags("codex")).toEqual(["--model", "gpt-6-luna", "--verbose"]);
  });

  it("treats absent modelIds like an unsaved model", async () => {
    getSettings.mockResolvedValue({ customArgs: "" });
    expect(await loadCustomLaunchFlags("claude")).toEqual(["--model", "sonnet"]);
  });

  it("falls back to the CLI default when the installed CLI doesn't offer the recommendation", async () => {
    getSettings.mockResolvedValue({ modelIds: {}, customArgs: "" });
    getResolvedModelList.mockResolvedValue(catalog("codex", ["gpt-5.6-sol", "gpt-5.5"]));
    expect(await loadCustomLaunchFlags("codex")).toEqual([]);
  });

  it("keeps the recommendation when the catalog can't be read", async () => {
    getSettings.mockResolvedValue({ modelIds: {}, customArgs: "" });
    getResolvedModelList.mockRejectedValue(new Error("ipc down"));
    expect(await loadCustomLaunchFlags("codex")).toEqual(["--model", "gpt-6-luna"]);
  });

  it("never gates an explicit choice on the catalog", async () => {
    getSettings.mockResolvedValue({ modelIds: { codex: "gpt-5.5" }, customArgs: "" });
    expect(await loadCustomLaunchFlags("codex")).toEqual(["--model", "gpt-5.5"]);
    expect(getResolvedModelList).not.toHaveBeenCalled();
  });

  it("injects no model for an agent without a recommended one", async () => {
    getSettings.mockResolvedValue({ modelIds: {}, customArgs: "" });
    expect(await loadCustomLaunchFlags("opencode")).toEqual([]);
  });

  it("reads only the launching agent's own entry", async () => {
    getSettings.mockResolvedValue({
      modelIds: { claude: "opus", codex: "gpt-6-astra" },
      customArgs: "",
    });
    expect(await loadCustomLaunchFlags("claude")).toEqual(["--model", "opus"]);
    expect(await loadCustomLaunchFlags("codex")).toEqual(["--model", "gpt-6-astra"]);
  });

  it("never passes another agent's model to this launch", async () => {
    getSettings.mockResolvedValue({ modelIds: { claude: "opus" }, customArgs: "" });
    expect(await loadCustomLaunchFlags("codex")).toEqual(["--model", "gpt-6-luna"]);
  });

  it("launches a custom model the catalog doesn't list for the agent it was set on", async () => {
    getSettings.mockResolvedValue({ modelIds: { codex: "my-fork-model" }, customArgs: "" });
    expect(await loadCustomLaunchFlags("codex")).toEqual(["--model", "my-fork-model"]);
    expect(await loadCustomLaunchFlags("claude")).toEqual(["--model", "sonnet"]);
  });

  it("ignores inherited object keys as agent entries", async () => {
    getSettings.mockResolvedValue({ modelIds: {}, customArgs: "" });
    expect(await loadCustomLaunchFlags("toString")).toEqual([]);
  });

  it("returns [] when reading settings throws", async () => {
    getSettings.mockRejectedValue(new Error("ipc down"));
    expect(await loadCustomLaunchFlags("claude")).toEqual([]);
  });
});
