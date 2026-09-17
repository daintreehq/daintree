import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { activate } from "../index.js";
import { createSandbox, createTestHost, type Sandbox } from "./testHost.js";
import { CHANNELS } from "../../shared/protocol.js";

const repoModules = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../node_modules"
);

let sandbox: Sandbox | null = null;
afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = null;
});

async function open(css: string | null) {
  sandbox = await createSandbox();
  // The real engine's stylesheets, where the fixture only carries a manifest.
  const tailwind = path.join(sandbox.worktree, "node_modules", "tailwindcss");
  await fs.rm(tailwind, { recursive: true, force: true });
  await fs.symlink(path.join(repoModules, "tailwindcss"), tailwind, "dir");
  if (css !== null) await fs.writeFile(sandbox.file("src/app.css"), css);
  const test = createTestHost(sandbox.worktree);
  await activate(test.host);
  const opened = await test.invoke<{ workspaceSessionId: string }>(CHANNELS.workspaceOpen, {
    projectId: "p1",
    worktreeId: "w1",
    worktreePath: sandbox.worktree,
    appRoot: sandbox.appRoot,
    previewPanelId: "preview-1",
  });
  const { workspaceSessionId } = opened;
  return {
    conflicts: (existing: string[], candidates: string[]) =>
      test.invoke<Record<string, unknown>>(CHANNELS.classConflicts, {
        workspaceSessionId,
        existing,
        candidates,
      }),
    status: () =>
      test.invoke<Record<string, unknown>>(CHANNELS.tailwindStatus, { workspaceSessionId }),
    describe: (token: string) =>
      test.invoke<Record<string, unknown>>(CHANNELS.classDescribe, { workspaceSessionId, token }),
  };
}

describe("class awareness", () => {
  it("describes tokens the class list leaves out: variants and arbitrary values", async () => {
    const tailwind = await open('@import "tailwindcss";\n');
    expect(await tailwind.status()).toEqual({ status: "available", skippedModules: [] });

    for (const token of ["p-4", "hover:p-4", "w-[37px]"]) {
      const described = await tailwind.describe(token);
      expect(described).toMatchObject({ status: "ok", partial: false });
      expect(described.css).toEqual(expect.any(String));
    }
    expect(await tailwind.describe("hero")).toEqual({ status: "ok", css: null, partial: false });
  }, 60_000);

  it("marks the model partial when a plugin was not run", async () => {
    const tailwind = await open('@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n');
    expect(await tailwind.status()).toMatchObject({
      status: "available",
      skippedModules: ["@tailwindcss/typography"],
    });
    expect(await tailwind.describe("prose")).toEqual({ status: "ok", css: null, partial: true });
  }, 60_000);

  it("tells a site that doesn't use Tailwind apart from one where it failed", async () => {
    const tailwind = await open(null);
    expect(await tailwind.status()).toMatchObject({ status: "unavailable", unused: true });
    expect(await tailwind.describe("hero")).toMatchObject({ status: "unavailable", unused: true });
  }, 60_000);

  it("doesn't call Tailwind unused when a stylesheet couldn't be read", async () => {
    const tailwind = await open(null);
    // Found by the scan, refused by the read: past the source size cap.
    await fs.mkdir(sandbox!.file("src/styles"), { recursive: true });
    await fs.writeFile(sandbox!.file("src/styles/site.css"), "a{}".repeat(1_000_000));
    expect(await tailwind.status()).toMatchObject({ status: "unavailable", unused: false });
  }, 60_000);

  it("doesn't call Tailwind unused when a listed stylesheet is denied", async () => {
    const tailwind = await open(null);
    const denied = sandbox!.file("src/styles/locked.css");
    await fs.mkdir(path.dirname(denied), { recursive: true });
    await fs.writeFile(denied, '@import "tailwindcss";\n');
    await fs.chmod(denied, 0o000);
    try {
      expect(await tailwind.status()).toMatchObject({ status: "unavailable", unused: false });
    } finally {
      await fs.chmod(denied, 0o644);
    }
  }, 60_000);

  it("reports a stylesheet that fails to compile as a failure, not as absence", async () => {
    const tailwind = await open('@import "tailwindcss";\n@import "./missing-theme.css";\n');
    expect(await tailwind.status()).toMatchObject({ status: "unavailable", unused: false });
  }, 60_000);

  it("describes prefixed utilities exactly as the project writes them", async () => {
    const tailwind = await open('@import "tailwindcss" prefix(tw);\n');
    expect((await tailwind.describe("tw:hover:p-4")).css).toEqual(expect.any(String));
    expect((await tailwind.describe("tw:w-[37px]")).css).toEqual(expect.any(String));
    expect(await tailwind.describe("p-4")).toMatchObject({ css: null });
  }, 60_000);

  it("finds the classes an addition overrides, by what they write and where", async () => {
    const tailwind = await open('@import "tailwindcss";\n');
    const result = await tailwind.conflicts(["px-6", "py-3", "hover:px-2", "rounded-lg"], ["px-8"]);
    expect(result).toEqual({
      status: "ok",
      conflicts: [
        { candidate: "px-8", token: "px-6", properties: ["padding-left", "padding-right"] },
      ],
    });
  }, 60_000);

  it("picks up a change to an imported theme file without reopening", async () => {
    const tailwind = await open('@import "tailwindcss";\n@import "./theme.css";\n');
    const theme = sandbox!.file("src/theme.css");
    await fs.writeFile(theme, "@theme { --color-brand: #111111; }\n");
    // The first request compiles; the theme was written before it.
    expect((await tailwind.describe("bg-brand")).css).toContain("--color-brand");
    const before = await tailwind.status();

    await fs.writeFile(theme, "@theme { --color-accent: #222222; }\n");
    expect(await tailwind.describe("bg-brand")).toMatchObject({ css: null });
    expect((await tailwind.describe("bg-accent")).css).toContain("--color-accent");
    expect(before).toMatchObject({ status: "available" });
  }, 60_000);

  it("refuses a stylesheet import from outside the worktree", async () => {
    const tailwind = await open('@import "tailwindcss";\n');
    const outside = path.join(path.dirname(sandbox!.worktree), "outside.css");
    await fs.writeFile(outside, "@theme { --color-secret: #000; }\n");
    await fs.writeFile(
      sandbox!.file("src/app.css"),
      `@import "tailwindcss";\n@import "${outside}";\n`
    );
    const status = await tailwind.status();
    expect(status).toMatchObject({ status: "unavailable", unused: false });
    expect(String(status.reason)).toContain("outside the worktree");
  }, 60_000);

  it("refuses an oversized imported stylesheet rather than stalling on it", async () => {
    const tailwind = await open('@import "tailwindcss";\n@import "./huge.css";\n');
    await fs.writeFile(sandbox!.file("src/huge.css"), "/*" + "x".repeat(3 * 1024 * 1024) + "*/");
    const status = await tailwind.status();
    expect(status).toMatchObject({ status: "unavailable", unused: false });
    expect(String(status.reason)).toContain("too large");
  }, 60_000);

  it("notices a change to an imported stylesheet larger than a source file may be", async () => {
    const tailwind = await open('@import "tailwindcss";\n@import "./big-theme.css";\n');
    const theme = sandbox!.file("src/big-theme.css");
    const padding = `/*${"x".repeat(1_500_000)}*/\n`;
    await fs.writeFile(theme, `${padding}@theme { --color-brand: #111111; }\n`);
    expect((await tailwind.describe("bg-brand")).css).toContain("--color-brand");

    await fs.writeFile(theme, `${padding}@theme { --color-accent: #222222; }\n`);
    expect(await tailwind.describe("bg-brand")).toMatchObject({ css: null });
  }, 60_000);

  it("stops at the stylesheet count bound, even for imports loaded side by side", async () => {
    const count = 300;
    const imports = Array.from({ length: count }, (_, index) => `@import "./parts/p${index}.css";`);
    const tailwind = await open(`@import "tailwindcss";\n${imports.join("\n")}\n`);
    await fs.mkdir(sandbox!.file("src/parts"), { recursive: true });
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        fs.writeFile(sandbox!.file(`src/parts/p${index}.css`), `.p${index}{color:red}\n`)
      )
    );
    const status = await tailwind.status();
    expect(status).toMatchObject({ status: "unavailable", unused: false });
    expect(String(status.reason)).toContain("stylesheets are imported");
  }, 60_000);

  it("enforces the total stylesheet budget across imports read side by side", async () => {
    const count = 9;
    const imports = Array.from({ length: count }, (_, index) => `@import "./big/b${index}.css";`);
    const tailwind = await open(`@import "tailwindcss";\n${imports.join("\n")}\n`);
    await fs.mkdir(sandbox!.file("src/big"), { recursive: true });
    const body = `/*${"x".repeat(1_900_000)}*/\n`;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        fs.writeFile(sandbox!.file(`src/big/b${index}.css`), body)
      )
    );
    const status = await tailwind.status();
    expect(status).toMatchObject({ status: "unavailable", unused: false });
    expect(String(status.reason)).toContain("too large in total");
  }, 60_000);

  it("recompiles when an imported stylesheet symlink is pointed at another file", async () => {
    const tailwind = await open('@import "tailwindcss";\n@import "./theme.css";\n');
    await fs.writeFile(sandbox!.file("src/light.css"), "@theme { --color-light: #fff; }\n");
    await fs.writeFile(sandbox!.file("src/dark.css"), "@theme { --color-dark: #000; }\n");
    await fs.symlink("light.css", sandbox!.file("src/theme.css"));
    expect((await tailwind.describe("bg-light")).css).toContain("--color-light");

    await fs.rm(sandbox!.file("src/theme.css"));
    await fs.symlink("dark.css", sandbox!.file("src/theme.css"));
    expect((await tailwind.describe("bg-dark")).css).toContain("--color-dark");
  }, 60_000);
});
