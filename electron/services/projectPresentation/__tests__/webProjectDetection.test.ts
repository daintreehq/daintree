import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWebProject } from "../webProjectDetection.js";

let root: string;

async function write(relative: string, content: string | object): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
}

async function mkdir(relative: string): Promise<void> {
  await fs.mkdir(path.join(root, relative), { recursive: true });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "web-project-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("detectWebProject: shown by default", () => {
  it.each([
    ["Next", { dependencies: { next: "15.0.0", react: "19.0.0" } }],
    ["Nuxt", { devDependencies: { nuxt: "3.0.0" } }],
    ["SvelteKit", { devDependencies: { "@sveltejs/kit": "2.0.0", vite: "6.0.0" } }],
    ["Astro", { dependencies: { astro: "5.0.0" } }],
    ["Remix", { devDependencies: { "@remix-run/dev": "2.0.0" } }],
    ["React Router", { devDependencies: { "@react-router/dev": "7.0.0" } }],
    ["Create React App", { dependencies: { "react-scripts": "5.0.1" } }],
    ["Eleventy", { devDependencies: { "@11ty/eleventy": "3.0.0" } }],
  ])("a %s app at the root", async (_name, pkg) => {
    await write("package.json", pkg);
    expect(await detectWebProject(root)).toBe(true);
  });

  it("a Vite app, which serves the index.html beside it", async () => {
    await write("package.json", { devDependencies: { vite: "6.0.0" } });
    await write("index.html", "<!doctype html>");
    expect(await detectWebProject(root)).toBe(true);
  });

  it("a framework this list doesn't know, by the dev server its script starts", async () => {
    await write("package.json", { scripts: { dev: "vite --port 4000" } });
    expect(await detectWebProject(root)).toBe(true);
  });

  it.each([
    ["pnpm", "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'packages/*'\n"],
    ["Turborepo", "turbo.json", "{}"],
    ["Nx", "nx.json", "{}"],
  ])("a %s workspace with a web app under apps/", async (_name, marker, content) => {
    await write("package.json", { private: true, devDependencies: { turbo: "2.0.0" } });
    await write(marker, content);
    await write("packages/ui/package.json", { devDependencies: { vite: "6.0.0" } });
    await write("apps/web/package.json", { dependencies: { next: "15.0.0" } });
    expect(await detectWebProject(root)).toBe(true);
  });

  it("an npm workspace naming its own package folders", async () => {
    await write("package.json", { workspaces: ["sites/*"] });
    await write("sites/marketing/package.json", { dependencies: { astro: "5.0.0" } });
    expect(await detectWebProject(root)).toBe(true);
  });

  it("a backend with its front end in a folder beside it", async () => {
    await write("go.mod", "module example.com/app\n");
    await write("frontend/package.json", { dependencies: { "react-scripts": "5.0.1" } });
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Rails", async () => {
    await write("Gemfile", 'source "https://rubygems.org"\n\ngem "rails", "~> 8.0"\n');
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Django", async () => {
    await write(
      "manage.py",
      'import os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "site.settings")\nfrom django.core.management import execute_from_command_line\n'
    );
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Laravel", async () => {
    await write("artisan", "#!/usr/bin/env php\n");
    await write("composer.json", { require: { "laravel/framework": "^11.0" } });
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Phoenix", async () => {
    await write("mix.exs", 'defp deps do\n  [{:phoenix, "~> 1.7"}]\nend\n');
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Hugo, by its own config", async () => {
    await write("hugo.toml", "baseURL = 'https://example.org/'\n");
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Hugo's older config, by the URL it names and the content beside it", async () => {
    await write("config.toml", 'baseURL = "https://example.org/"\ntitle = "Site"\n');
    await mkdir("content");
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Jekyll", async () => {
    await write("_config.yml", "title: Blog\n");
    await mkdir("_posts");
    expect(await detectWebProject(root)).toBe(true);
  });

  it("Eleventy, by its config alone", async () => {
    await write("eleventy.config.js", "export default function () {}\n");
    expect(await detectWebProject(root)).toBe(true);
  });

  it("a static site with a page at its root", async () => {
    await write("index.html", "<!doctype html>");
    expect(await detectWebProject(root)).toBe(true);
  });
});

describe("detectWebProject: hidden by default", () => {
  it("a Python CLI", async () => {
    await write(
      "pyproject.toml",
      '[project]\nname = "tool"\n[project.scripts]\ntool = "tool:main"\n'
    );
    expect(await detectWebProject(root)).toBe(false);
  });

  it("a Go library", async () => {
    await write("go.mod", "module example.com/lib\n");
    await write("lib.go", "package lib\n");
    expect(await detectWebProject(root)).toBe(false);
  });

  it("a Rust crate", async () => {
    await write("Cargo.toml", '[package]\nname = "crate"\n');
    expect(await detectWebProject(root)).toBe(false);
  });

  it("an npm library or Node CLI", async () => {
    await write("package.json", {
      bin: { tool: "dist/cli.js" },
      scripts: { build: "tsup", dev: "tsup --watch", test: "vitest" },
      devDependencies: { tsup: "8.0.0", vitest: "3.0.0", vite: "6.0.0" },
    });
    expect(await detectWebProject(root)).toBe(false);
  });

  it("a Python repo with a tooling-only package.json", async () => {
    await write("pyproject.toml", '[project]\nname = "svc"\n');
    await write("package.json", {
      private: true,
      scripts: { prepare: "husky", format: "prettier --write ." },
      devDependencies: { prettier: "3.0.0", husky: "9.0.0" },
    });
    expect(await detectWebProject(root)).toBe(false);
  });

  it("a library that builds with Vite and has no page to serve", async () => {
    await write("package.json", {
      scripts: { build: "vite build", test: "vitest run", dev: "vite build --watch" },
      devDependencies: { vite: "6.0.0", vitest: "3.0.0" },
    });
    expect(await detectWebProject(root)).toBe(false);
  });

  it("a Makefile with nothing but a test target", async () => {
    await write("Makefile", "test:\n\tgo test ./...\n");
    expect(await detectWebProject(root)).toBe(false);
  });

  it("a config that names a URL with no site content beside it", async () => {
    await write("config.yaml", "baseUrl: https://api.example.com\n");
    expect(await detectWebProject(root)).toBe(false);
  });

  it("an empty folder", async () => {
    expect(await detectWebProject(root)).toBe(false);
  });
});

describe("detectWebProject: reading", () => {
  it("is unknown, not no, for a root that can't be read", async () => {
    expect(await detectWebProject(path.join(root, "missing"))).toBeNull();
    expect(await detectWebProject(undefined)).toBeNull();
    await write("file.txt", "");
    expect(await detectWebProject(path.join(root, "file.txt"))).toBeNull();
  });

  it("answers again once the folder is scaffolded", async () => {
    expect(await detectWebProject(root)).toBe(false);
    await write("package.json", { devDependencies: { "@sveltejs/kit": "2.0.0" } });
    expect(await detectWebProject(root)).toBe(true);
  });

  it("shrugs off a manifest it can't parse", async () => {
    await write("package.json", "{ not json");
    await write("pnpm-workspace.yaml", "packages: [unterminated");
    expect(await detectWebProject(root)).toBe(false);
  });

  it("follows no link, at the root or into a workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "web-project-outside-"));
    try {
      await fs.writeFile(
        path.join(outside, "package.json"),
        JSON.stringify({ dependencies: { next: "15.0.0" } })
      );
      await fs.symlink(path.join(outside, "package.json"), path.join(root, "package.json"));
      await write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
      await mkdir("apps");
      await fs.symlink(outside, path.join(root, "apps", "web"));
      await fs.symlink(outside, path.join(root, "frontend"));
      expect(await detectWebProject(root)).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("never leaves the root for a workspace pattern that points outside it", async () => {
    await write("package.json", { workspaces: ["../*", "../sibling", "**"] });
    expect(await detectWebProject(root)).toBe(false);
  });

  it("looks no deeper than one level into a workspace folder", async () => {
    await write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
    await write("apps/group/web/package.json", { dependencies: { next: "15.0.0" } });
    expect(await detectWebProject(root)).toBe(false);
  });

  it("stops after a bounded number of workspace packages", async () => {
    await write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    for (let i = 0; i < 40; i++) {
      await write(`packages/lib-${String(i).padStart(2, "0")}/package.json`, { name: `lib-${i}` });
    }
    // Sorted after every library, so only a scan past the cap would reach it.
    await write("packages/zz-site/package.json", { dependencies: { next: "15.0.0" } });
    expect(await detectWebProject(root)).toBe(false);
  });
});
