import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { createFixtureRepo, type FixtureRepo } from "../../helpers/fixtures";

/**
 * Direct dependencies are pinned exactly so a new SvelteKit, Vite or Tailwind
 * release can't change what this suite proves between two runs a day apart.
 * Transitive dependencies still float — there is no lockfile, because a checked
 * in one would pin a platform's optional binaries (`@tailwindcss/oxide-*`) to
 * whichever machine generated it.
 *
 * Tailwind shares its minor with Daintree's bundled engine on purpose: the
 * builder only offers class completion when the two agree.
 */
export const SVELTEKIT_VERSIONS = {
  "@sveltejs/adapter-auto": "7.0.1",
  "@sveltejs/kit": "2.70.3",
  "@sveltejs/vite-plugin-svelte": "7.3.0",
  "@tailwindcss/vite": "4.3.3",
  svelte: "5.57.0",
  tailwindcss: "4.3.3",
  vite: "8.3.0",
} as const;

export const PAGE_FILE = "src/routes/+page.svelte";

export const PAGE_SOURCE = `<main class="flex flex-col gap-4 p-6">
  <h1 class="text-4xl font-bold">Daintree site builder</h1>
  <p class="text-base">Point at an element to find the source that owns it.</p>
</main>
`;

const FILES: Record<string, string> = {
  "package.json":
    JSON.stringify(
      {
        name: "daintree-e2e-sveltekit",
        private: true,
        version: "0.0.1",
        type: "module",
        scripts: { dev: "vite dev" },
        devDependencies: SVELTEKIT_VERSIONS,
      },
      null,
      2
    ) + "\n",
  ".gitignore": "node_modules/\n.svelte-kit/\n",
  ".npmrc": "engine-strict=true\n",
  "svelte.config.js": `import adapter from "@sveltejs/adapter-auto";

export default { kit: { adapter: adapter() } };
`,
  "vite.config.js": `import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [tailwindcss(), sveltekit()] });
`,
  "src/app.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body>
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
  "src/app.css": '@import "tailwindcss";\n',
  "src/routes/+layout.svelte": `<script>
  import "../app.css";
  let { children } = $props();
</script>

{@render children()}
`,
  [PAGE_FILE]: PAGE_SOURCE,
};

const INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * A real SvelteKit 2 + Svelte 5 + Tailwind 4 app in a throwaway git repo, with
 * its dependencies installed from the registry. Needs network on first run;
 * later runs are served from the npm cache.
 */
export function createSvelteKitProject(name: string): FixtureRepo {
  const repo = createFixtureRepo({ name });
  try {
    for (const [relative, contents] of Object.entries(FILES)) {
      const target = path.join(repo.dir, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }

    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--no-audit", "--no-fund", "--prefer-offline", "--loglevel=error"],
      {
        cwd: repo.dir,
        stdio: "pipe",
        timeout: INSTALL_TIMEOUT_MS,
        shell: process.platform === "win32",
      }
    );

    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.dir, stdio: "pipe" });
    git("add", "-A");
    git("commit", "-m", "SvelteKit fixture", "--no-gpg-sign");
    return repo;
  } catch (error) {
    repo.cleanup();
    throw error;
  }
}
