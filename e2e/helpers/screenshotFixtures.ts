import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import path from "path";
import { execSync } from "child_process";
import { removePathSync } from "./fixtures";

/**
 * Demo repos live at a clean, sanitized base path so the title bar / project
 * footer don't expose Windows `C:\Users\runneradmin\AppData\Local\Temp\...`
 * paths in marketing screenshots. Windows: C:\Projects\<slug>. POSIX:
 * /tmp/daintree-demos/<slug>. Override with DAINTREE_DEMO_ROOT.
 */
export function getDemoRoot(): string {
  if (process.env.DAINTREE_DEMO_ROOT) return process.env.DAINTREE_DEMO_ROOT;
  if (process.platform === "win32") return "C:\\Projects";
  return "/tmp/daintree-demos";
}

interface DemoRepoOptions {
  /** Marketing slug — also used as folder basename, so it shows in the title bar. */
  slug: string;
  /** Files to create relative to the repo root. */
  files: Record<string, string>;
  /** Branches to create after the initial commit (no commits added on them). */
  branches?: string[];
  /**
   * Worktree definitions. Each adds a `git worktree add` for the given branch
   * with optional files written into the worktree before committing.
   */
  worktrees?: Array<{
    branch: string;
    /** Files to create + commit inside the worktree. */
    files?: Record<string, string>;
    /** Optional uncommitted files written after commit. */
    uncommittedFiles?: Record<string, string>;
  }>;
  /** Recipes to write to .daintree/recipes/. */
  recipes?: Array<{ filename: string; content: object }>;
}

export interface DemoRepo {
  dir: string;
  slug: string;
  cleanup: () => void;
}

function git(cmd: string, cwd: string) {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

export function writeFiles(root: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(root, relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * Build a marketing demo repo on disk. The folder basename uses `slug` so
 * the title bar reads e.g. "surge-checkout" rather than "daintree-e2e-xxxxx".
 *
 * Sanitized — no API-key-shaped strings, no real user paths, no
 * identifiable third-party code. All content is original demo material.
 */
export function createDemoRepo(opts: DemoRepoOptions): DemoRepo {
  // Sanitized base: C:\Projects\<slug> on Windows, /tmp/daintree-demos/<slug>
  // on POSIX. The project header in the app shows this path, so we keep it
  // looking like a normal developer project location.
  const root = getDemoRoot();
  mkdirSync(root, { recursive: true });
  const dir = path.join(root, opts.slug);
  // Clean any leftover from a prior run so `git init` doesn't trip.
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  // Also clean the sibling -worktrees dir if it exists.
  const worktreeSibling = path.join(root, `${opts.slug}-worktrees`);
  if (existsSync(worktreeSibling)) {
    try {
      rmSync(worktreeSibling, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  mkdirSync(dir, { recursive: true });

  git("init -b main", dir);
  git('config user.email "demo@daintree.dev"', dir);
  git('config user.name "Daintree Demo"', dir);

  // Always include a README. Other files come from opts.files.
  if (!opts.files["README.md"]) {
    writeFileSync(path.join(dir, "README.md"), `# ${opts.slug}\n`);
  }
  writeFiles(dir, opts.files);

  if (opts.recipes?.length) {
    const recipesDir = path.join(dir, ".daintree", "recipes");
    mkdirSync(recipesDir, { recursive: true });
    for (const recipe of opts.recipes) {
      writeFileSync(
        path.join(recipesDir, recipe.filename),
        JSON.stringify(recipe.content, null, 2) + "\n"
      );
    }
  }

  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  for (const branch of opts.branches ?? []) {
    git(`branch ${branch}`, dir);
  }

  if (opts.worktrees?.length) {
    const worktreesParent = path.join(root, `${opts.slug}-worktrees`);
    mkdirSync(worktreesParent, { recursive: true });
    for (const wt of opts.worktrees) {
      const safeBranch = wt.branch.replace(/\//g, "-");
      const worktreePath = path.join(worktreesParent, safeBranch);
      // Create branch first if it doesn't exist
      try {
        execSync(`git rev-parse --verify ${wt.branch}`, { cwd: dir, stdio: "ignore" });
      } catch {
        git(`branch ${wt.branch}`, dir);
      }
      git(`worktree add ${JSON.stringify(worktreePath)} ${wt.branch}`, dir);
      if (wt.files && Object.keys(wt.files).length > 0) {
        writeFiles(worktreePath, wt.files);
        git("add -A", worktreePath);
        git(`commit -m "${wt.branch} work"`, worktreePath);
      }
      if (wt.uncommittedFiles) {
        writeFiles(worktreePath, wt.uncommittedFiles);
      }
    }
  }

  return {
    dir,
    slug: opts.slug,
    cleanup: () => {
      try {
        removePathSync(dir);
      } catch {
        // best-effort
      }
      try {
        removePathSync(worktreeSibling);
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Scene catalog — one demo repo per Microsoft Store screenshot.
// Each project is fictional but plausibly realistic. No API key shapes,
// no real-user paths, no identifiable third-party code.
// ---------------------------------------------------------------------------

/** Scene 1 — 🌊 surge-checkout — payments / refund flow. */
export function createSurgeCheckoutRepo(): DemoRepo {
  return createDemoRepo({
    slug: "surge-checkout",
    files: {
      "README.md": `# 🌊 surge-checkout

A fast, embeddable checkout layer for online merchants.

- One-tap card capture
- Programmable refund flow
- Stateless webhook router
`,
      "package.json": JSON.stringify(
        {
          name: "surge-checkout",
          version: "0.4.2",
          private: true,
          scripts: { dev: "node server.js", test: "node --test" },
        },
        null,
        2
      ),
      "src/checkout.ts": `import { Cart, Charge } from "./types";

export async function startCheckout(cart: Cart): Promise<Charge> {
  // Validate the cart line items before touching the card network.
  if (cart.items.length === 0) throw new Error("empty cart");
  return processCharge(cart);
}

async function processCharge(cart: Cart): Promise<Charge> {
  // TODO: add refund flow — see issue #142
  return { id: "ch_demo", amount: cart.total, status: "pending" };
}
`,
      "src/refund.ts": `// Refund pipeline — work in progress.
// Goal: idempotent partial refunds with audit trail.
`,
      "src/types.ts": `export interface Cart {
  items: Array<{ sku: string; qty: number; price: number }>;
  total: number;
}

export interface Charge {
  id: string;
  amount: number;
  status: "pending" | "captured" | "refunded";
}
`,
    },
  });
}

/** Scene 2 — 🎨 brush-cms — content management with mixed-state worktrees. */
export function createBrushCmsRepo(suffix = ""): DemoRepo {
  return createDemoRepo({
    slug: suffix ? `brush-cms-${suffix}` : "brush-cms",
    files: {
      "README.md": `# 🎨 brush-cms

Visual-first content management for design teams.
`,
      "package.json": JSON.stringify(
        { name: "brush-cms", version: "1.2.0", private: true },
        null,
        2
      ),
      "src/editor/RichTextEditor.tsx": `export function RichTextEditor() {
  return <div className="editor" />;
}
`,
      "src/assets/AssetLibrary.tsx": `export function AssetLibrary() {
  return <ul className="asset-grid" />;
}
`,
      "src/auth/redirect.ts": `// Auth callback handler.
export function handleAuthRedirect(): void {
  // Bug: state param can be lost when navigating across origins.
}
`,
    },
    worktrees: [
      {
        branch: "feature/rich-text-editor",
        files: {
          "src/editor/toolbar.ts": "// Toolbar implementation in progress\n",
        },
      },
      {
        branch: "feature/asset-library",
        files: {
          "src/assets/cdn.ts": "// CDN sync for asset library\n",
        },
      },
      {
        branch: "bugfix/auth-redirect",
        files: {
          "src/auth/redirect.ts": `export function handleAuthRedirect(): void {
  const state = sessionStorage.getItem("oauth-state");
  if (!state) throw new Error("missing oauth state");
}
`,
        },
      },
    ],
  });
}

/**
 * Scene 3 — 🌴 daintree-site — the Daintree marketing site itself.
 * The dev preview shows daintree.org via a local reverse proxy. Slightly
 * meta, but it sells the "live preview while you edit" story with real
 * production content instead of a fake portfolio.
 */
export function createDaintreeSiteRepo(): DemoRepo {
  return createDemoRepo({
    slug: "daintree-site",
    files: {
      "README.md": `# 🌴 daintree-site

The Daintree marketing site. \`npm run dev\` starts a local reverse proxy
to daintree.org so you can preview production while editing.
`,
      "package.json": JSON.stringify(
        {
          name: "daintree-site",
          version: "1.4.0",
          private: true,
          scripts: { dev: "node dev-server.cjs" },
        },
        null,
        2
      ),
      "dev-server.cjs": `// Reverse proxy to daintree.org for the dev preview screenshot scene.
// Strips X-Frame-Options / CSP frame-ancestors so the preview can render
// inside Daintree's webview. Falls back to an offline placeholder if
// daintree.org is unreachable.
const http = require("http");
const https = require("https");

const TARGET_HOST = "daintree.org";
const PORT = Number(process.env.PORT) || 4173;

const FALLBACK_HTML = \`<!doctype html><html><head><meta charset="utf-8"/>
<title>Daintree — local preview</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0e0e0d;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}h1{font-size:48px;margin:0}</style>
</head><body><div><h1>🌴 Daintree</h1><p>Live preview unavailable in this environment.</p></div></body></html>\`;

function proxy(req, res) {
  const opts = {
    hostname: TARGET_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: TARGET_HOST },
    timeout: 8000,
  };
  delete opts.headers["accept-encoding"]; // let the response be uncompressed

  const upstream = https.request(opts, (ures) => {
    const headers = { ...ures.headers };
    // Strip frame-blocking headers so this renders in the dev preview webview.
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];
    delete headers["content-security-policy-report-only"];
    res.writeHead(ures.statusCode || 502, headers);
    ures.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FALLBACK_HTML);
  });
  req.pipe(upstream);
}

http.createServer(proxy).listen(PORT, () => {
  console.log("Listening on http://localhost:" + PORT + " (proxy → https://" + TARGET_HOST + ")");
});
`,
      "src/pages/index.astro": `---
// Daintree marketing homepage
---
<html>
  <head><title>Daintree — orchestrate AI coding agents</title></head>
  <body>
    <h1>Daintree</h1>
    <p>Run Claude, OpenCode, and Codex side by side.</p>
  </body>
</html>
`,
      "src/components/Hero.astro": `---
// Hero section for the marketing homepage
---
<section class="hero">
  <h1>Orchestrate AI coding agents</h1>
  <p>Worktree dashboard. Live preview. Multi-agent recipes.</p>
</section>
`,
    },
  });
}

/** Scene 4 — 🚀 launchpad-analytics — analytics dashboard. Recipes seed the palette options. */
export function createLaunchpadAnalyticsRepo(): DemoRepo {
  return createDemoRepo({
    slug: "launchpad-analytics",
    files: {
      "README.md": `# 🚀 launchpad-analytics

Funnel and retention dashboards for product teams.
`,
      "package.json": JSON.stringify(
        { name: "launchpad-analytics", version: "2.1.0", private: true },
        null,
        2
      ),
      "src/funnel/Funnel.tsx": `export function Funnel() {
  return <section className="funnel" />;
}
`,
      "src/retention/Retention.tsx": `export function Retention() {
  return <section className="retention" />;
}
`,
      "src/index.tsx": "// entry point\n",
    },
    recipes: [
      {
        filename: "audit-accessibility.json",
        content: {
          name: "Audit accessibility",
          showInEmptyState: true,
          terminals: [
            {
              type: "claude",
              title: "Accessibility audit",
              command:
                "Review every component in src/ for accessibility regressions. Focus on focus rings, keyboard navigation, and ARIA labels.",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "write-funnel-tests.json",
        content: {
          name: "Write funnel tests",
          terminals: [
            {
              type: "opencode",
              title: "Funnel test suite",
              command:
                "Generate vitest tests for src/funnel/Funnel.tsx covering the empty, partial, and full-funnel states.",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "refactor-to-typescript.json",
        content: {
          name: "Refactor to TypeScript",
          terminals: [
            {
              type: "claude",
              title: "TS refactor",
              command:
                "Convert any remaining .js files in src/ to TypeScript. Preserve existing exports and add types based on usage.",
              exitBehavior: "keep",
            },
          ],
        },
      },
    ],
  });
}

/** Scene 5 — 🛰️ orbital-sync — multi-region sync, multi-agent shot. */
export function createOrbitalSyncRepo(): DemoRepo {
  return createDemoRepo({
    slug: "orbital-sync",
    files: {
      "README.md": `# 🛰️ orbital-sync

Multi-region eventually-consistent state sync.
`,
      "package.json": JSON.stringify(
        { name: "orbital-sync", version: "0.6.0", private: true },
        null,
        2
      ),
      "src/retry/backoff.ts": `// Exponential backoff with jitter.
export function backoff(attempt: number): number {
  return Math.min(30_000, 250 * Math.pow(2, attempt)) + Math.random() * 100;
}
`,
      "src/retry/policy.ts": `// Retry policy — to be expanded with circuit-breaker logic.
`,
      "src/sync/region.ts": `export type Region = "us-east" | "ap-south" | "eu-west";
`,
    },
  });
}

/** Scene 6 — 🍳 mise-en-place — recipe library scene. */
export function createMiseEnPlaceRepo(): DemoRepo {
  return createDemoRepo({
    slug: "mise-en-place",
    files: {
      "README.md": `# 🍳 mise-en-place

Weekly meal planning with a personal pantry.
`,
      "package.json": JSON.stringify(
        { name: "mise-en-place", version: "1.0.0", private: true },
        null,
        2
      ),
      "src/MealPlan.tsx": `export function MealPlan() {
  return <table className="plan" />;
}
`,
      "src/pantry/Pantry.tsx": `export function Pantry() {
  return <ul className="pantry" />;
}
`,
    },
    recipes: [
      {
        filename: "refactor-to-typescript.json",
        content: {
          name: "Refactor to TypeScript",
          showInEmptyState: true,
          terminals: [
            {
              type: "claude",
              title: "TS migration",
              command:
                "Convert the remaining JavaScript files in src/ to TypeScript with strict mode types.",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "add-e2e-tests.json",
        content: {
          name: "Add e2e tests",
          terminals: [
            {
              type: "claude",
              title: "Playwright setup",
              command:
                "Add a Playwright e2e suite covering the meal-plan creation flow end-to-end.",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "audit-security.json",
        content: {
          name: "Audit security",
          terminals: [
            {
              type: "opencode",
              title: "Security audit",
              command:
                "Walk every dependency in package.json and flag any with known CVEs. Suggest replacements where possible.",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "generate-api-docs.json",
        content: {
          name: "Generate API docs",
          terminals: [
            {
              type: "claude",
              title: "API docs",
              command: "Generate a docs/api.md file describing every exported function in src/.",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "update-meal-plan-model.json",
        content: {
          name: "Update meal-plan model",
          terminals: [
            {
              type: "claude",
              title: "Schema update",
              command: "Add a 'leftovers' field to the MealPlan model and migrate existing plans.",
              exitBehavior: "keep",
            },
          ],
        },
      },
    ],
  });
}
