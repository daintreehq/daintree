import { describe, it, expect, beforeEach } from "vitest";
import {
  usePluginPromptStore,
  enqueueUiPrompt,
  dismissValueFor,
  __resetPluginPromptStoreForTesting,
} from "../pluginPromptStore";
import type { PluginUiPromptRequest } from "@shared/types/pluginUiPrompt";

function quickPickRequest(promptId: string, pluginId: string): PluginUiPromptRequest {
  return { promptId, pluginId, params: { kind: "quickPick", items: [], options: {} } };
}

function confirmRequest(promptId: string, pluginId: string): PluginUiPromptRequest {
  return { promptId, pluginId, params: { kind: "confirm", options: { title: "Sure?" } } };
}

describe("pluginPromptStore", () => {
  beforeEach(() => {
    __resetPluginPromptStoreForTesting();
  });

  it("dismissValueFor maps confirm→false and the others→undefined", () => {
    expect(dismissValueFor("confirm")).toBe(false);
    expect(dismissValueFor("quickPick")).toBeUndefined();
    expect(dismissValueFor("inputBox")).toBeUndefined();
  });

  it("surfaces the first prompt and queues the rest FIFO", () => {
    void enqueueUiPrompt(quickPickRequest("a", "p1"));
    void enqueueUiPrompt(quickPickRequest("b", "p1"));
    const state = usePluginPromptStore.getState();
    expect(state.current?.promptId).toBe("a");
    expect(state.queue.map((q) => q.promptId)).toEqual(["b"]);
  });

  it("resolveCurrent resolves the awaiting promise and promotes the next prompt", async () => {
    const first = enqueueUiPrompt(quickPickRequest("a", "p1"));
    void enqueueUiPrompt(quickPickRequest("b", "p1"));

    const answer = { id: "x", label: "X" };
    usePluginPromptStore.getState().resolveCurrent(answer);

    await expect(first).resolves.toEqual(answer);
    expect(usePluginPromptStore.getState().current?.promptId).toBe("b");
  });

  it("stores each resolver inside its queue item (not a module-level map)", () => {
    void enqueueUiPrompt(quickPickRequest("a", "p1"));
    const item = usePluginPromptStore.getState().current;
    expect(typeof item?.resolve).toBe("function");
  });

  it("cancelByPluginId resolves matching prompts with the dismiss value and drops them", async () => {
    const p1Current = enqueueUiPrompt(confirmRequest("a", "p1"));
    const p2Queued = enqueueUiPrompt(quickPickRequest("b", "p2"));
    const p1Queued = enqueueUiPrompt(quickPickRequest("c", "p1"));

    usePluginPromptStore.getState().cancelByPluginId("p1");

    // confirm → false, quick-pick → undefined; both p1 prompts dropped.
    await expect(p1Current).resolves.toBe(false);
    await expect(p1Queued).resolves.toBeUndefined();

    // p2's prompt is promoted to current and left pending.
    const state = usePluginPromptStore.getState();
    expect(state.current?.promptId).toBe("b");
    expect(state.queue).toHaveLength(0);

    usePluginPromptStore.getState().resolveCurrent({ id: "k", label: "Kept" });
    await expect(p2Queued).resolves.toEqual({ id: "k", label: "Kept" });
  });

  it("cancelByPluginId can target a single promptId", async () => {
    const a = enqueueUiPrompt(quickPickRequest("a", "p1"));
    const b = enqueueUiPrompt(quickPickRequest("b", "p1"));

    usePluginPromptStore.getState().cancelByPluginId("p1", "b");

    await expect(b).resolves.toBeUndefined();
    const state = usePluginPromptStore.getState();
    expect(state.current?.promptId).toBe("a");
    expect(state.queue).toHaveLength(0);
    // a is still pending
    usePluginPromptStore.getState().resolveCurrent({ id: "a", label: "A" });
    await expect(a).resolves.toEqual({ id: "a", label: "A" });
  });
});
