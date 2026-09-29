import { afterEach, describe, expect, it } from "vitest";
import { cleanupPlugins, lintFor } from "./lintFixtures.js";

afterEach(cleanupPlugins);

describe("interval-polling-in-view", () => {
  it("flags setInterval in view code", async () => {
    const findings = await lintFor("interval-polling-in-view", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel() {
  useEffect(() => {
    const t = setInterval(() => refresh(), 1000);
    return () => clearInterval(t);
  }, []);
  return <div />;
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "src/panel.tsx", line: 4, severity: "warn" });
    // Subscribe before pulling, or a push that lands between the two is lost.
    expect(findings[0]!.hint).toMatch(/subscribe first and then pull/);
    expect(findings[0]!.hint).toMatch(/revision/);
  });

  it("leaves worker polling alone, which the docs recommend", async () => {
    const findings = await lintFor("interval-polling-in-view", {
      "src/index.ts": `export async function activate(host) {
  const timer = setInterval(() => void refresh(host), 15_000);
  return () => clearInterval(timer);
}
`,
    });
    expect(findings).toEqual([]);
  });

  it("ignores setInterval in comments and strings", async () => {
    const findings = await lintFor("interval-polling-in-view", {
      "src/panel.tsx": `// setInterval(poll, 1000) was too chatty
export default function Panel() {
  return <p>Don't call "setInterval(" here</p>;
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("undebounced-worktree-subscription", () => {
  it("flags onDidChangeWorktrees without options", async () => {
    const findings = await lintFor("undebounced-worktree-subscription", {
      "src/index.ts": `export async function activate(host) {
  host.onDidChangeWorktrees((worktrees) => render(worktrees));
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(2);
  });

  it("flags an options object without debounceMs, and a host fs.watch without one", async () => {
    const findings = await lintFor("undebounced-worktree-subscription", {
      "src/index.ts": `export async function activate(host) {
  host.onDidChangeWorktrees(render, { signal });
  host.fs.watch([dir], onChange, { recursive: true });
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([2, 3]);
  });

  it("accepts explicit intent, including debounceMs: 0, and opaque options", async () => {
    const findings = await lintFor("undebounced-worktree-subscription", {
      "src/index.ts": `import fs from "node:fs";
export async function activate(host, opts) {
  host.onDidChangeWorktrees(render, { debounceMs: 200 });
  host.onDidChangeWorktrees(render, { debounceMs: 0 });
  host.onDidChangeWorktrees(render, opts);
  host.fs.watch([dir], onChange, { debounceMs: 100 });
  fs.watch(dir, () => {});
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("subscription-without-dispose", () => {
  it("flags a view subscription whose disposer is dropped", async () => {
    const findings = await lintFor("subscription-without-dispose", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    window.electron.plugin.on(pluginId, "slate", setSlate);
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(4);
  });

  it("does not guess about onDid* calls, which a view cannot prove return a disposer", async () => {
    const findings = await lintFor("subscription-without-dispose", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ store }) {
  useEffect(() => {
    store.onDidChange(refresh);
  }, [store]);
  return null;
}
`,
    });
    expect(findings).toEqual([]);
  });

  it("accepts a kept, returned or collected disposer", async () => {
    const findings = await lintFor("subscription-without-dispose", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    const off = window.electron.plugin.on(pluginId, "slate", setSlate);
    return () => off();
  }, [pluginId]);
  useEffect(() => window.electron.plugin.onPanel(pluginId, "doc", "p1", setDoc), [pluginId]);
  useEffect(() => {
    const subs = [];
    subs.push(window.electron.plugin.on(pluginId, "a", setA));
    return () => subs.forEach((s) => s());
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("large-inline-payload", () => {
  it("flags posting the whole collection on every iteration over it", async () => {
    const findings = await lintFor("large-inline-payload", {
      "src/index.ts": `export async function activate(host) {
  for (const item of contributions) {
    register(item);
    await host.postToPanel("contributions", contributions);
  }
  contributions.forEach((c) => host.broadcastToRenderer("all", { contributions }));
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([4, 6]);
  });

  it("accepts per-item posts and per-instance pushes in a loop", async () => {
    const findings = await lintFor("large-inline-payload", {
      "src/index.ts": `export async function activate(host) {
  for (const item of items) {
    await host.postToPanel("item", item);
  }
  for (const panelId of panels) {
    await host.postToPanel("doc", { count: items.length }, panelId);
  }
  await host.postToPanel("items", items);
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("render-on-every-event", () => {
  it("flags appending to state per event, and setting state on a high-frequency channel", async () => {
    const findings = await lintFor("render-on-every-event", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    const a = window.electron.plugin.on(pluginId, "line", (line) => setLines((prev) => [...prev, line]));
    const b = window.electron.plugin.on(pluginId, "build-progress", setProgress);
    return () => { a(); b(); };
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([4, 5]);
    expect(findings[0]!.message).toMatch(/copies the collection/);
    expect(findings[1]!.message).not.toMatch(/renders once per event/);
    for (const hook of [
      "useThrottledCallback",
      "usePluginEventSelector",
      "useVirtualList",
      "useProgressiveList",
    ]) {
      expect(findings[0]!.hint).toContain(hook);
    }
    expect(findings[0]!.hint).toMatch(/buffer flushed once per frame for appends/);
  });

  it("accepts coalesced handlers and ordinary low-frequency state", async () => {
    const findings = await lintFor("render-on-every-event", {
      "src/panel.tsx": `import { useEffect } from "react";
export default function Panel({ pluginId }) {
  useEffect(() => {
    const a = window.electron.plugin.on(pluginId, "slate", setSlate);
    const b = window.electron.plugin.on(pluginId, "output", (chunk) => {
      pending.push(chunk);
      requestAnimationFrame(() => setOutput(pending.join("")));
    });
    return () => { a(); b(); };
  }, [pluginId]);
  return null;
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("bundled-react", () => {
  const BUILD = { "vite.config.ts": "export default {};\n" };

  it("flags a built view that carries React's own internals", async () => {
    const findings = await lintFor("bundled-react", {
      ...BUILD,
      "src/panel.tsx": "export default function Panel() { return null; }\n",
      "dist/panel.js": `import "./chunks/vendor.js";\nexport default function P() {}\n`,
      "dist/chunks/vendor.js": `/** @license React react.production.js */\nvar x = {}; x.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = {};\n`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "dist/chunks/vendor.js", severity: "error" });
  });

  it("accepts a bundle that imports React from the host import map", async () => {
    const findings = await lintFor("bundled-react", {
      ...BUILD,
      "src/panel.tsx": "export default function Panel() { return null; }\n",
      "dist/panel.js": `import { jsx } from "react/jsx-runtime";\nexport default function P() { return jsx("div", {}); }\n`,
    });
    expect(findings).toEqual([]);
  });
});

describe("whole-state-push", () => {
  it("flags re-sending a collection that only grows, alone or beside the new item", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/index.ts": `export async function activate(host) {
  const calls = [];
  host.onToolCall(async (call) => {
    calls.push(call);
    await host.postToPanel("tool-call", { call, calls });
  });
  const log = [];
  host.onLine((line) => {
    log = [...log, line];
    void host.postToPanel("log", log);
  });
}
`,
    });
    expect(findings.map((f) => f.line)).toEqual([5, 10]);
    expect(findings[0]!.hint).toMatch(/createSyncedCollection/);
    expect(findings[0]!.message).toMatch(/`calls`/);
  });

  it("flags posting the object that owns a growing member", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/state.ts": `const state = { events: [], count: 0 };
export function record(host, event) {
  state.events.push(event);
  state.count++;
  return host.postToPanel("state", state);
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 5 });
  });

  it("accepts deltas, bounded buffers and unrelated members", async () => {
    const findings = await lintFor("whole-state-push", {
      "src/index.ts": `export async function activate(host) {
  const calls = [];
  host.onToolCall(async (call) => {
    calls.push(call);
    await host.postToPanel("tool-call", { call, total: calls.length });
  });
  const recent = [];
  host.onLine((line) => {
    recent.push(line);
    if (recent.length > 50) recent.shift();
    void host.postToPanel("recent", recent);
  });
  const state = { events: [], status: "idle" };
  host.onEvent((event) => {
    state.events.push(event);
    void host.postToPanel("status", state.status);
  });
}
`,
    });
    expect(findings).toEqual([]);
  });
});

describe("perf hints point at the SDK hooks", () => {
  it("names useStreamBuffer and useSyncedCollection for per-event appends", async () => {
    const findings = await lintFor("render-on-every-event", {
      "src/panel.tsx": `import { usePluginEvent } from "@daintreehq/plugin-sdk/react";
export default function Panel({ pluginId }) {
  const [lines, setLines] = useState([]);
  usePluginEvent(pluginId, "output", (line) => setLines((prev) => [...prev, line]));
  return <pre>{lines.join("")}</pre>;
}
`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.hint).toMatch(/useStreamBuffer/);
    expect(findings[0]!.hint).toMatch(/useSyncedCollection/);
  });
});
