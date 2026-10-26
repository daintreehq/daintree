import { describe, expect, it } from "vitest";
import { checkRendererStorage } from "../ci/rendererStorageCheck";
import { scanSources } from "../ci/rendererStorageScan";
import {
  SETTING_CATALOG,
  rendererStorageDeclaration,
  rendererStorageOwner,
} from "../../shared/config/settingOwnership";

const src = (files: Record<string, string>) => new Map(Object.entries(files));

describe("renderer storage scan", () => {
  it("reads a persist store's name and a localStorage key through named constants", () => {
    const uses = scanSources(
      src({
        "a.ts": `import { persist } from "zustand/middleware";
const KEY = "daintree-a";
create(persist(() => ({}), { name: KEY }));`,
        "b.ts": `const PREFIX = "daintree-b:"; const K = \`\${PREFIX}\${id}\`;
localStorage.getItem(K);`,
      })
    );
    expect([...new Set(uses.map((u) => u.keys[0]))].sort()).toEqual(["daintree-a", "daintree-b:"]);
  });

  it("ignores a local function called persist that is not zustand's", () => {
    expect(scanSources(src({ "a.ts": `persist(group, apply, "x");` }))).toEqual([]);
  });

  it("reads a key that only a comment can name", () => {
    const [use] = scanSources(
      src({
        "a.ts": `function read(key: string) {
  // storage-key: one-key two-key
  return localStorage.getItem(key);
}`,
      })
    );
    expect(use?.keys).toEqual(["one-key", "two-key"]);
  });
});

describe("renderer storage check", () => {
  it("fails a persist store with no declaration", () => {
    const problems = checkRendererStorage(
      src({
        "a.ts": `import { persist } from "zustand/middleware";
create(persist(() => ({}), { name: "daintree-new-thing" }));`,
      }),
      []
    );
    expect(problems.map((p) => p.message).join()).toMatch(/daintree-new-thing/);
  });

  it("fails a raw localStorage key with no declaration, and one it cannot read", () => {
    const problems = checkRendererStorage(
      src({ "a.ts": `localStorage.setItem("daintree-raw", "1"); localStorage.getItem(dyn());` }),
      ["daintree-other"]
    );
    const text = problems.map((p) => p.message).join("\n");
    expect(text).toMatch(/daintree-raw/);
    expect(text).toMatch(/cannot read this storage key/);
    expect(text).toMatch(/daintree-other.*not used/);
  });

  it("passes when a prefix entry covers the key", () => {
    expect(
      checkRendererStorage(src({ "a.ts": `localStorage.getItem("p:" + id);` }), ["p:*"])
    ).toEqual([]);
  });
});

describe("renderer storage catalog", () => {
  it("looks up exact and prefixed keys without importing electron", () => {
    expect(rendererStorageDeclaration("daintree-panel-limits")).toEqual({
      owner: "device",
      scope: "global",
    });
    expect(rendererStorageDeclaration("daintree-sidebar-view:host:abc")?.scope).toBe("host");
    expect(rendererStorageOwner("daintree-preferences")).toBe("device");
    expect(rendererStorageDeclaration("nope")).toBeUndefined();
    expect(() => rendererStorageOwner("nope")).toThrow(/No renderer storage key/);
  });

  it("declares a scope and owner on every entry", () => {
    for (const store of [
      SETTING_CATALOG["renderer-local-storage"],
      SETTING_CATALOG["renderer-session-storage"],
    ]) {
      for (const entry of Object.values(store.entries)) {
        expect(entry).toMatchObject({ owner: expect.any(String), scope: expect.any(String) });
      }
    }
  });
});
