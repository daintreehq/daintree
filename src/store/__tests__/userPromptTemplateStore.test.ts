// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPromptTemplatesSnapshot } from "@shared/types/ipc/userPromptTemplates";
import { logError } from "@/utils/logger";
import {
  _resetUserPromptTemplateStoreForTest,
  useUserPromptTemplateStore,
} from "../userPromptTemplateStore";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

function snapshot(ids: string[], problemFiles: string[] = []): UserPromptTemplatesSnapshot {
  return {
    directory: "/home/me/.daintree/templates",
    templates: ids.map((id) => ({ id, title: id, description: "d", body: "b", args: [] })),
    problems: problemFiles.map((fileName) => ({ fileName, reason: "bad" })),
  };
}

function deferredReads() {
  const reads: {
    resolve: (value: UserPromptTemplatesSnapshot) => void;
    reject: (error: Error) => void;
  }[] = [];
  const list = vi.fn(
    () =>
      new Promise<UserPromptTemplatesSnapshot>((resolve, reject) => {
        reads.push({ resolve, reject });
      })
  );
  Reflect.set(window, "electron", { userPromptTemplates: { list } });
  return { reads, list };
}

const state = () => useUserPromptTemplateStore.getState();
const ids = () => state().templates.map((t) => t.id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("userPromptTemplateStore", () => {
  beforeEach(() => {
    _resetUserPromptTemplateStoreForTest();
    vi.mocked(logError).mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("holds what the folder read gave, and each read replaces the last", async () => {
    const { reads } = deferredReads();
    state().refresh();
    reads[0]!.resolve(snapshot(["a", "b"], ["bad.md"]));
    await flush();
    expect(ids()).toEqual(["a", "b"]);
    expect(state().problems).toEqual([{ fileName: "bad.md", reason: "bad" }]);
    expect(state().directory).toBe("/home/me/.daintree/templates");

    state().refresh();
    reads[1]!.resolve(snapshot(["b"]));
    await flush();
    expect(ids()).toEqual(["b"]);
    expect(state().problems).toEqual([]);
  });

  it("keeps a slice's identity when a read changes nothing, so the menu's highlight stays", async () => {
    const { reads } = deferredReads();
    state().refresh();
    reads[0]!.resolve(snapshot(["a"], ["bad.md"]));
    await flush();
    const { templates, problems } = state();

    state().refresh();
    reads[1]!.resolve(snapshot(["a"], ["bad.md"]));
    await flush();

    expect(state().templates).toBe(templates);
    expect(state().problems).toBe(problems);
  });

  it("doesn't let a slow older read overwrite a newer one", async () => {
    const { reads } = deferredReads();
    state().refresh();
    state().refresh();
    reads[1]!.resolve(snapshot(["new"]));
    await flush();
    reads[0]!.resolve(snapshot(["old"]));
    await flush();
    expect(ids()).toEqual(["new"]);
  });

  it("doesn't let a failed newer read throw away a good older one", async () => {
    const { reads } = deferredReads();
    state().refresh();
    state().refresh();
    reads[1]!.reject(new Error("gone"));
    await flush();
    reads[0]!.resolve(snapshot(["good"]));
    await flush();
    expect(ids()).toEqual(["good"]);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("keeps what it has when a read fails", async () => {
    const { reads } = deferredReads();
    state().refresh();
    reads[0]!.resolve(snapshot(["a"]));
    await flush();

    state().refresh();
    reads[1]!.reject(new Error("gone"));
    await flush();

    expect(ids()).toEqual(["a"]);
  });

  it("reads once however many composers ask to start, and again on every refresh", () => {
    const { list } = deferredReads();
    state().init();
    state().init();
    expect(list).toHaveBeenCalledTimes(1);
    state().refresh();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("drops a read still in flight when reset", async () => {
    const { reads } = deferredReads();
    state().refresh();
    _resetUserPromptTemplateStoreForTest();
    reads[0]!.resolve(snapshot(["before-the-reset"]));
    await flush();
    expect(ids()).toEqual([]);
  });

  it("does nothing on a bridge without the namespace", () => {
    Reflect.set(window, "electron", {});
    expect(() => state().refresh()).not.toThrow();
    expect(ids()).toEqual([]);
  });
});
