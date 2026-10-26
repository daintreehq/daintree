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

  it("reads storage reached through a parameter typed Storage", () => {
    const [use] = scanSources(
      src({
        "a.ts": `function write(store: Storage, key: string) {
  store.setItem(key, "1");
}`,
      })
    );
    expect(use).toMatchObject({ how: "storage-call", keys: [] });
    expect(use?.reason).toMatch(/`key`/);
  });

  it("reads storage reached through a function declared to return Storage", () => {
    const uses = scanSources(
      src({
        "a.ts": `function storage(): Storage | null {
  return globalThis.localStorage ?? null;
}
const s = storage();
s?.setItem("x", "1");
storage()!.removeItem("y");`,
      })
    );
    expect(uses.map((u) => u.keys)).toEqual([["x"], ["y"]]);
  });

  it("leaves zustand's StateStorage alone", () => {
    expect(
      scanSources(
        src({ "a.ts": `function read(store: StateStorage) { return store.getItem("z"); }` })
      )
    ).toEqual([]);
  });

  it("reads each name through the declaration in its own scope", () => {
    const files = {
      "a.ts": `function a() {
  const key = "daintree-undeclared";
  localStorage.setItem(key, "1");
}
function b() {
  const key = "daintree-declared";
  localStorage.setItem(key, "1");
}`,
    };
    expect(scanSources(src(files)).map((u) => u.keys)).toEqual([
      ["daintree-undeclared"],
      ["daintree-declared"],
    ]);
    expect(checkRendererStorage(src(files), ["daintree-declared"]).map((p) => p.message)).toEqual([
      expect.stringMatching(/"daintree-undeclared" has no declared owner/),
    ]);
  });

  it("never reads a parameter, loop variable or let as a same-named constant", () => {
    const uses = scanSources(
      src({
        "a.ts": `const storageKey = "daintree-declared";
localStorage.getItem(storageKey);
function write(storageKey: string) {
  localStorage.setItem(storageKey, "1");
}
for (const storageKey of list) localStorage.removeItem(storageKey);
function later() {
  let storageKey = "daintree-declared";
  localStorage.getItem(storageKey);
}`,
      })
    );
    expect(uses.map((u) => u.keys)).toEqual([["daintree-declared"], [], [], []]);
  });

  it("reads an imported constant only from a module inside the scanned tree", () => {
    const files = {
      "src/keys.ts": `export const MY_KEY = "daintree-mine";`,
      "src/a.ts": `import { MY_KEY } from "./keys";\nlocalStorage.getItem(MY_KEY);`,
      "src/b.ts": `import { MY_KEY } from "@/keys";\nlocalStorage.getItem(MY_KEY);`,
      "src/c.ts": `import { MY_KEY } from "@shared/keys";\nlocalStorage.getItem(MY_KEY);`,
      "src/d.ts": `import { MY_KEY } from "../shared/keys";\nlocalStorage.getItem(MY_KEY);`,
    };
    const keysByFile = Object.fromEntries(scanSources(src(files)).map((u) => [u.file, u.keys]));
    expect(keysByFile).toEqual({
      "src/a.ts": ["daintree-mine"],
      "src/b.ts": ["daintree-mine"],
      "src/c.ts": [],
      "src/d.ts": [],
    });
  });

  it("reads a persist store called through a namespace import", () => {
    const uses = scanSources(
      src({
        "a.ts": `import * as mw from "zustand/middleware";
create(mw.persist(() => ({}), { name: "ns-store" }));
other.persist(() => ({}), { name: "not-zustand" });`,
      })
    );
    expect(uses).toEqual([expect.objectContaining({ how: "persist-name", keys: ["ns-store"] })]);
  });

  it("skips a key-named constant marked declared-elsewhere, and any not valued like ours", () => {
    const uses = scanSources(
      src({
        "a.ts": `// storage-key: declared-elsewhere
export const FIELD_KEY = "daintree-field";
export const VIEW_KEY_PREFIX = "kit:viewState:";
export const OTHER_KEY = "daintree-other";
writeStorage(FIELD_KEY);`,
      })
    );
    expect(uses.map((u) => u.keys)).toEqual([["daintree-other"]]);
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

  it("holds a key built at runtime to a prefix declaration", () => {
    const files = { "a.ts": `localStorage.setItem("daintree-preferences" + suffix, "1");` };
    expect(
      checkRendererStorage(src(files), ["daintree-preferences"]).map((p) => p.message)
    ).toEqual([expect.stringMatching(/built at runtime/), expect.stringMatching(/not used/)]);
    expect(checkRendererStorage(src(files), ["daintree-preferences*"])).toEqual([]);
  });

  it("reads an aliased persist import and an aliased storage variable", () => {
    const problems = checkRendererStorage(
      src({
        "a.ts": `import { persist as keep } from "zustand/middleware";
create(keep(() => ({}), { name: "alias-store" }));
const store = window.localStorage;
store.setItem("alias-key", "1");`,
      }),
      []
    );
    expect(problems.map((p) => p.message).join()).toMatch(/alias-store[\s\S]*alias-key/);
  });

  it("reads a constant only where the file defines or imports it", () => {
    const [use] = scanSources(
      src({
        "a.ts": `export const OTHER_KEY = "daintree-elsewhere";`,
        "b.ts": `function read(storageKey: string) { return localStorage.getItem(storageKey); }`,
      })
    );
    expect(use?.keys).toEqual([]);
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
    expect(rendererStorageDeclaration("daintree-preferences.__bak")?.owner).toBe("device");
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
