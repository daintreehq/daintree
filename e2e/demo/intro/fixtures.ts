import { mkdirSync, realpathSync, writeFileSync } from "fs";
import path from "path";
import { createDemoRepo, type DemoRepo } from "../../helpers/screenshotFixtures";

const tsx = (name: string, body: string) => `export function ${name}() {\n${body}\n}\n`;

export function createBrushCms(): DemoRepo {
  return createDemoRepo({
    slug: "brush-cms",
    files: {
      "README.md": "# Brush CMS\n\nA headless CMS with a collaborative rich text editor.\n",
      "package.json": JSON.stringify(
        {
          name: "brush-cms",
          version: "0.8.0",
          type: "module",
          scripts: { dev: "vite", test: "node --test tests/" },
        },
        null,
        2
      ),
      "src/editor/RichTextEditor.tsx": tsx(
        "RichTextEditor",
        '  return <div className="editor" contentEditable suppressContentEditableWarning />;'
      ),
      "src/editor/Toolbar.tsx": tsx("Toolbar", '  return <div role="toolbar" />;'),
      "src/assets/AssetLibrary.tsx": tsx(
        "AssetLibrary",
        "  const assets = useAssets();\n  return <Grid items={assets} />;"
      ),
      "src/assets/useAssets.ts":
        "export function useAssets() {\n  return fetch('/api/assets').then((r) => r.json());\n}\n",
      "src/auth/redirect.ts":
        "export function handleAuthRedirect(url: URL): string {\n  return url.searchParams.get('next') ?? '/';\n}\n",
      "src/api/server.ts": "import express from 'express';\n\nexport const app = express();\n",
      "tests/redirect.test.mjs":
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('keeps same-origin paths', () => {\n  assert.equal(new URL('/dashboard', 'https://brush.dev').pathname, '/dashboard');\n});\n\ntest('rejects protocol-relative redirects', () => {\n  assert.equal(new URL('//evil.example', 'https://brush.dev').host, 'brush.dev');\n});\n",
    },
    worktrees: [
      {
        branch: "feature/asset-library",
        files: {
          "src/assets/AssetGrid.tsx": tsx("AssetGrid", '  return <ul className="grid" />;'),
        },
        uncommittedFiles: {
          "src/assets/AssetLibrary.tsx": `import { useState } from "react";
import { AssetGrid } from "./AssetGrid";
import { useAssets } from "./useAssets";

export function AssetLibrary() {
  const [query, setQuery] = useState("");
  const assets = useAssets({ query, limit: 60 });
  return (
    <section className="asset-library">
      <input
        aria-label="Search assets"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <AssetGrid items={assets} onSelect={(asset) => insertAsset(asset)} />
    </section>
  );
}
`,
          "src/assets/useAssets.ts": `export interface AssetQuery {
  query: string;
  limit: number;
}

export async function useAssets({ query, limit }: AssetQuery) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await fetch(\`/api/assets?\${params}\`);
  if (!res.ok) throw new Error(\`Asset search failed: \${res.status}\`);
  return res.json();
}
`,
          "src/assets/insertAsset.ts": `import { editor } from "../editor/instance";

export function insertAsset(asset: { url: string; alt: string }) {
  editor.chain().focus().setImage({ src: asset.url, alt: asset.alt }).run();
}
`,
        },
      },
      {
        branch: "feature/rich-text-editor",
        files: {
          "src/editor/marks.ts": "export const marks = ['bold', 'italic', 'code'];\n",
        },
      },
      {
        branch: "bugfix/auth-redirect",
        files: {
          "src/auth/redirect.test.ts":
            "import { handleAuthRedirect } from './redirect';\n\ntest('rejects external urls', () => {});\n",
        },
      },
    ],
  });
}

export function createSurgeCheckout(): DemoRepo {
  return createDemoRepo({
    slug: "surge-checkout",
    files: {
      "README.md": "# Surge Checkout\n\nPayments and checkout service.\n",
      "src/checkout.ts":
        "export async function startCheckout(cart: Cart) {\n  return charge(cart);\n}\n",
      "src/tax.ts": "export const taxFor = (cents: number) => Math.round(cents * 0.1);\n",
    },
    worktrees: [
      { branch: "feature/apple-pay", files: { "src/wallets/applePay.ts": "export {};\n" } },
      { branch: "fix/tax-rounding", files: { "src/tax.test.ts": "test('rounds', () => {});\n" } },
    ],
  });
}

export function createOrbitalSync(): DemoRepo {
  return createDemoRepo({
    slug: "orbital-sync",
    files: {
      "README.md": "# Orbital Sync\n\nOffline-first sync engine.\n",
      "src/queue.ts": "export class SyncQueue {}\n",
      "src/backoff.ts": "export const backoff = (n: number) => Math.min(30_000, 2 ** n * 100);\n",
    },
    worktrees: [
      { branch: "feature/offline-queue", files: { "src/offline.ts": "export {};\n" } },
      { branch: "perf/batch-writes", files: { "src/batch.ts": "export {};\n" } },
    ],
  });
}

const VIDEOS: Array<{ slug: string; title: string; status: string; progress: number }> = [
  { slug: "daintree-intro", title: "Daintree in 5 minutes", status: "Editing", progress: 80 },
  {
    slug: "worktrees-explained",
    title: "Git worktrees explained",
    status: "Recording",
    progress: 55,
  },
  { slug: "agent-fleets", title: "Running an agent fleet", status: "Scripting", progress: 35 },
  { slug: "code-review-flow", title: "Reviewing agent code", status: "Research", progress: 15 },
  {
    slug: "plugin-deep-dive",
    title: "Building a Daintree plugin",
    status: "Research",
    progress: 10,
  },
  {
    slug: "mcp-control",
    title: "Controlling Daintree over MCP",
    status: "Published",
    progress: 100,
  },
];

export function createVideoStudio(): DemoRepo {
  const files: Record<string, string> = {
    "README.md": "# Video Studio\n\nScripts, research and production notes for every video.\n",
    ".gitignore": "node_modules\n",
  };
  for (const v of VIDEOS) {
    files[`videos/${v.slug}.md`] = `---
title: ${v.title}
status: ${v.status}
progress: ${v.progress}
---

# ${v.title}

## Hook

Open on the product doing the thing, then say why it matters.

## Outline

1. The problem
2. The demo
3. How it works
4. Call to action

## Script

So at its most basic level...
`;
    files[`research/${v.slug}.md`] =
      `# Research: ${v.title}\n\n- Sources\n- Competitor videos\n- Open questions\n`;
  }
  const repo = createDemoRepo({ slug: "video-studio", files });
  writeVideoPlugin(repo.dir);
  return repo;
}

function writeVideoPlugin(repoDir: string): void {
  const root = path.join(repoDir, ".daintree", "plugins", "studio.videos");
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(
    path.join(root, "plugin.json"),
    JSON.stringify(
      {
        name: "studio.videos",
        version: "0.1.0",
        scope: "project",
        displayName: "Video Dashboard",
        description: "Production progress for every video in this project",
        main: "dist/index.mjs",
        engines: { daintree: ">=0.34.0" },
        activationEvents: ["onStartupFinished"],
        capabilities: ["fs:project-read"],
        scopes: { fs: { allowedPaths: ["${project}", "${worktree}"] } },
        contributes: {
          panels: [
            {
              id: "dashboard",
              name: "Video Dashboard",
              iconId: "monitor-play",
              color: "var(--theme-category-rose)",
              showInPalette: true,
            },
          ],
          views: [{ id: "dashboard", componentPath: "dist/panel.js", location: "panel" }],
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(root, "dist", "index.mjs"),
    `const FALLBACK_ROOT = ${JSON.stringify(realpathSync(repoDir))};
function parseFront(text) {
  const m = /^---\\n([\\s\\S]*?)\\n---/.exec(text);
  const o = {};
  if (m) for (const l of m[1].split("\\n")) { const i = l.indexOf(":"); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return o;
}
export async function activate(host) {
  await host.registerHandler("list-videos", async () => {
    const wt = await host.getActiveWorktree().catch(() => null);
    const root = wt?.path ?? FALLBACK_ROOT;
    const dir = root + "/videos";
    const entries = await host.fs.readdir(dir);
    const videos = [];
    for (const e of entries) {
      if (!e.name.endsWith(".md")) continue;
      const p = dir + "/" + e.name;
      const fm = parseFront(await host.fs.readFile(p));
      videos.push({ path: p, slug: e.name.replace(/\\.md$/, ""), title: fm.title ?? e.name, status: fm.status ?? "Draft", progress: Number(fm.progress ?? 0) });
    }
    videos.sort((a, b) => b.progress - a.progress);
    return { root, videos };
  });
  await host.registerHandler("open-file", async (_ctx, args) => {
    const r = await host.dispatch("file.openPanel", { path: args.path, rootPath: args.rootPath, viewMode: "source" });
    if (!r?.ok) throw new Error(r?.error?.message ?? "open failed");
    return r.result;
  });
  return () => {};
}
`
  );
  writeFileSync(
    path.join(root, "dist", "panel.js"),
    `import { createElement as h, useEffect, useState } from "react";
export default function Dashboard({ pluginId }) {
  const [data, setData] = useState({ root: null, videos: [] });
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const load = () => window.electron.plugin.invoke(pluginId, "list-videos").then((d) => {
      if (cancelled) return;
      if (d && d.videos && d.videos.length) { setData(d); setError(null); }
      else if (tries++ < 20) setTimeout(load, 500);
    }).catch((e) => { if (cancelled) return; setError(String(e && e.message || e)); if (tries++ < 20) setTimeout(load, 500); });
    load();
    return () => { cancelled = true; };
  }, [pluginId]);
  const total = data.videos.length;
  const avg = total ? Math.round(data.videos.reduce((s, v) => s + v.progress, 0) / total) : 0;
  return h("div", { className: "flex flex-col flex-1 min-h-0 h-full bg-surface-panel text-text-primary overflow-auto" },
    h("div", { className: "flex items-baseline justify-between px-5 pt-4 pb-3" },
      h("div", { className: "text-base font-semibold" }, "Video production"),
      h("div", { className: "text-xs text-text-secondary" }, total + " videos · " + avg + "% overall")),
    error && !total ? h("div", { className: "px-5 pb-3 text-xs text-status-error", "data-testid": "video-dashboard-error" }, error) : null,
    h("div", { className: "grid gap-3 px-5 pb-5", style: { gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" } },
      data.videos.map((v) => h("button", {
          key: v.path, type: "button", "data-testid": "video-card", "data-slug": v.slug,
          onClick: () => window.electron.plugin.invoke(pluginId, "open-file", { path: v.path, rootPath: data.root }),
          className: "flex flex-col gap-2 text-left rounded-lg border border-border-subtle bg-surface-inset p-3 hover:bg-overlay-subtle" },
        h("div", { className: "text-sm font-medium" }, v.title),
        h("div", { className: "flex justify-between text-xs text-text-secondary" }, h("span", null, v.status), h("span", null, v.progress + "%")),
        h("div", { className: "h-1.5 rounded-full bg-overlay-medium overflow-hidden" },
          h("div", { className: "h-full rounded-full " + (v.progress >= 100 ? "bg-status-success" : "bg-category-blue"), style: { width: v.progress + "%" } }))))));
}
`
  );
}

/** Global plugins shown in the Plugin Manager: written under a redirected HOME. */
export function writeGlobalPlugins(fakeHome: string): Record<string, unknown> {
  const plugins = [
    {
      name: "acme.flutter",
      displayName: "Flutter",
      tagline: "Device picker, hot reload and emulators",
      category: "workspace",
    },
    {
      name: "acme.workflow",
      displayName: "Release Workflow",
      tagline: "My own branch → review → ship pipeline",
      category: "workspace",
    },
    {
      name: "acme.linear",
      displayName: "Linear",
      tagline: "Issues and cycles beside your worktrees",
      category: "other",
    },
  ];
  const installed: Record<string, unknown> = {};
  for (const p of plugins) {
    const dir = path.join(fakeHome, ".daintree", "plugins", p.name);
    mkdirSync(path.join(dir, "main"), { recursive: true });
    writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify(
        {
          name: p.name,
          version: "1.2.0",
          displayName: p.displayName,
          tagline: p.tagline,
          description: p.tagline,
          category: p.category,
          main: "main/index.js",
          engines: { daintree: ">=0.11.0" },
          capabilities: [],
        },
        null,
        2
      )
    );
    writeFileSync(path.join(dir, "main", "index.js"), "export async function activate() {}\n");
    installed[p.name] = {
      source: "catalog",
      installedAt: Date.now() - 86_400_000 * 9,
      archiveHash: "0".repeat(64),
      originalUrl: null,
      disabled: false,
      updateAvailable: false,
      devMode: false,
      loadError: null,
    };
  }
  return installed;
}
