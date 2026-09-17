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
  });
  const { workspaceSessionId } = opened;
  return {
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
});
