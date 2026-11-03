import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeStore = vi.hoisted(() => {
  let data: Record<string, unknown> = {};
  return {
    reset(initial: Record<string, unknown>) {
      data = structuredClone(initial);
    },
    dump: () => data,
    get: vi.fn((key: string) => (data[key] === undefined ? undefined : structuredClone(data[key]))),
    set: vi.fn((key: string, value: unknown) => {
      const [root, field] = key.split(".") as [string, string];
      const current = (data[root] ?? {}) as Record<string, unknown>;
      data[root] = { ...current, [field]: structuredClone(value) };
    }),
  };
});

vi.mock("../../store.js", () => ({ store: fakeStore }));

import {
  PROJECT_IDENTITIES_MAX,
  readAssistantIdentities,
  readAssistantIdentity,
  sanitizeStoredIdentities,
  writeAssistantIdentity,
} from "../assistantIdentity.js";

describe("assistant identities (#16213)", () => {
  beforeEach(() => {
    fakeStore.reset({ helpAssistant: { docSearch: true } });
    fakeStore.set.mockClear();
  });

  it("reads none on a store that never had one", () => {
    expect(readAssistantIdentities()).toEqual({ global: {}, projects: {} });
  });

  it("keeps the global persona and each project's apart", () => {
    writeAssistantIdentity({
      scope: { kind: "global" },
      identity: { name: "Assistant to the Regional Manager", emoji: "🐻" },
    });
    writeAssistantIdentity({
      scope: { kind: "project", projectId: "p1" },
      identity: { name: "Dwight" },
    });
    writeAssistantIdentity({
      scope: { kind: "project", projectId: "p2" },
      identity: { emoji: "🌱" },
    });

    expect(readAssistantIdentity({ kind: "global" })).toEqual({
      name: "Assistant to the Regional Manager",
      emoji: "🐻",
    });
    expect(readAssistantIdentity({ kind: "project", projectId: "p1" })).toEqual({ name: "Dwight" });
    expect(readAssistantIdentity({ kind: "project", projectId: "p2" })).toEqual({ emoji: "🌱" });
    // The other settings under the key are left as they were.
    expect(fakeStore.dump().helpAssistant).toMatchObject({ docSearch: true });
  });

  it("clears a project's persona with an empty one and leaves the others", () => {
    writeAssistantIdentity({
      scope: { kind: "project", projectId: "p1" },
      identity: { name: "A" },
    });
    writeAssistantIdentity({
      scope: { kind: "project", projectId: "p2" },
      identity: { name: "B" },
    });

    const after = writeAssistantIdentity({
      scope: { kind: "project", projectId: "p1" },
      identity: { name: "  " },
    });

    expect(after.projects).toEqual({ p2: { name: "B" } });
  });

  it("refuses an emoji that is not one emoji before writing anything", () => {
    expect(() =>
      writeAssistantIdentity({ scope: { kind: "global" }, identity: { name: "X", emoji: "ab" } })
    ).toThrow(/single emoji/);
    expect(fakeStore.set).not.toHaveBeenCalled();
  });

  it("refuses a request without a scope it can name", () => {
    expect(() => writeAssistantIdentity({ scope: { kind: "project" }, identity: {} })).toThrow();
    expect(() => writeAssistantIdentity(null)).toThrow();
    expect(fakeStore.set).not.toHaveBeenCalled();
  });

  it("forgets the oldest project once the map is full", () => {
    const projects = Object.fromEntries(
      Array.from({ length: PROJECT_IDENTITIES_MAX }, (_, i) => [`p${i}`, { name: `n${i}` }])
    );
    fakeStore.reset({ helpAssistant: { identities: { projects } } });

    const after = writeAssistantIdentity({
      scope: { kind: "project", projectId: "new" },
      identity: { name: "newest" },
    });

    expect(Object.keys(after.projects)).toHaveLength(PROJECT_IDENTITIES_MAX);
    expect(after.projects.p0).toBeUndefined();
    expect(after.projects.new).toEqual({ name: "newest" });
  });

  it("reads a damaged store as safe personas, never a prototype key", () => {
    const stored = JSON.parse(
      '{"global":{"name":5,"emoji":"🐶"},"projects":{"__proto__":{"name":"x"},"p1":"bad","p2":{"name":" ok "}}}'
    );
    const identities = sanitizeStoredIdentities(stored);
    expect(identities.global).toEqual({ emoji: "🐶" });
    expect(Object.getPrototypeOf(identities.projects)).toBe(Object.prototype);
    expect(Object.keys(identities.projects).sort()).toEqual(["__proto__", "p2"]);
    expect(identities.projects.p2).toEqual({ name: "ok" });
    expect(sanitizeStoredIdentities("nonsense")).toEqual({ global: {}, projects: {} });
  });
});
