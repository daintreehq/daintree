import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig } from "../../config/agentRegistry.js";
import { loadModelTitleCatalog, MODEL_TITLE_CATALOG_WAIT_MS } from "../agentModelTitle.js";

const CODEX_MODELS = [{ id: "gpt-5.5", name: "GPT-5.5", shortLabel: "GPT-5.5" }];

describe("loadModelTitleCatalog (#16783)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the catalog for a model the agent's bundled list doesn't name", async () => {
    const read = vi.fn().mockResolvedValue({ models: CODEX_MODELS });

    await expect(loadModelTitleCatalog("codex", "gpt-5.5", read)).resolves.toEqual(CODEX_MODELS);
    expect(read).toHaveBeenCalledWith("codex");
  });

  it("reads nothing for no model, no reader, or a bundled model", async () => {
    const read = vi.fn().mockResolvedValue({ models: CODEX_MODELS });
    const bundled = getAgentConfig("qwen")!.models![0]!.id;

    await expect(loadModelTitleCatalog("codex", undefined, read)).resolves.toBeUndefined();
    await expect(loadModelTitleCatalog("codex", "gpt-5.5", undefined)).resolves.toBeUndefined();
    await expect(loadModelTitleCatalog("qwen", bundled, read)).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("resolves to nothing when the catalog fails, however it fails", async () => {
    await expect(
      loadModelTitleCatalog("codex", "gpt-5.5", () => Promise.reject(new Error("ipc gone")))
    ).resolves.toBeUndefined();
    await expect(
      loadModelTitleCatalog("codex", "gpt-5.5", () => {
        throw new Error("no bridge");
      })
    ).resolves.toBeUndefined();
    await expect(
      loadModelTitleCatalog("codex", "gpt-5.5", () => Promise.resolve(null))
    ).resolves.toBeUndefined();
  });

  it("waits out the deadline for a catalog that doesn't answer, then leaves no timer behind", async () => {
    vi.useFakeTimers();
    let answer: (value: { models: typeof CODEX_MODELS }) => void = () => {};
    const pending = new Promise<{ models: typeof CODEX_MODELS }>((resolve) => {
      answer = resolve;
    });
    let settled = false;

    const result = loadModelTitleCatalog("codex", "gpt-5.5", () => pending).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(MODEL_TITLE_CATALOG_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    answer({ models: CODEX_MODELS });
  });

  it("clears its deadline once the catalog answers", async () => {
    vi.useFakeTimers();

    await expect(
      loadModelTitleCatalog("codex", "gpt-5.5", async () => ({ models: CODEX_MODELS }))
    ).resolves.toEqual(CODEX_MODELS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
