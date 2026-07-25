import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Deliberately NOT mocked: every other CopyTreeService suite stubs `copytree`,
// so they only prove the adapter matches our assumptions about the SDK. This
// one runs the installed package, which is what catches an assumption that was
// wrong in the first place.
import { copyTreeService } from "../CopyTreeService.js";

describe("CopyTreeService against the installed CopyTree", () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-sdk-"));
    await fs.writeFile(path.join(tempDir, "small.ts"), "export const a = 1;\n");

    // CopyTree resolves the user's global excludes from `~/.gitconfig`,
    // `core.excludesFile` and `$XDG_CONFIG_HOME/git/ignore`. Left alone, a
    // developer's or runner's own global ignore would leak in: a host rule for
    // `*.ts` would break the positive assertions here, and — worse — a rule
    // matching one of the fixtures would let an exclusion test pass for the
    // wrong reason. Point the lookup at an empty home instead.
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-home-"));
    vi.stubEnv("HOME", fakeHome);
    vi.stubEnv("USERPROFILE", fakeHome);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(fakeHome, ".config"));
  });

  afterEach(async () => {
    copyTreeService.cancelAll();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  async function writeSized(name: string, bytes: number) {
    await fs.writeFile(path.join(tempDir, name), "x".repeat(bytes));
  }

  it("loads the packaged configuration and generates a versioned document", async () => {
    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("small.ts");
    // Proves ConfigManager.create({ userConfig: false, strict: true }) resolved
    // with real defaults — the fail-closed path would have errored instead.
    expect(result.outputFormatVersion).toBeTruthy();
    expect(result.stats?.estimatedTokens).toBeGreaterThan(0);
  });

  it("keeps a file larger than the SDK's 256KB default gate when no limit is set", async () => {
    await writeSized("big.ts", 300 * 1024);

    const result = await copyTreeService.testConfig(tempDir);

    expect(result.error).toBeUndefined();
    expect(result.files?.map((file) => file.path)).toContain("big.ts");
  });

  it("drops a file above an explicit max file size and says why", async () => {
    await writeSized("big.ts", 300 * 1024);

    const result = await copyTreeService.testConfig(tempDir, { maxFileSize: 100 * 1024 });

    expect(result.files?.map((file) => file.path)).not.toContain("big.ts");
    expect(result.excluded?.byReason.sizeGate).toBeGreaterThan(0);
  });

  it("lets an always pattern override the max file size gate", async () => {
    await writeSized("big.ts", 300 * 1024);

    const result = await copyTreeService.testConfig(tempDir, {
      maxFileSize: 100 * 1024,
      always: ["big.ts"],
    });

    expect(result.files?.map((file) => file.path)).toContain("big.ts");
  });

  it("does not redact a secret-shaped string, since the guard is off", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    await fs.writeFile(path.join(tempDir, "config.ts"), `export const key = "${secret}";\n`);

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBeUndefined();
    expect(result.content).toContain(secret);
  });

  it("reports gitignored files as excluded rather than silently omitting them", async () => {
    await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored.ts\n");
    await fs.writeFile(path.join(tempDir, "ignored.ts"), "export const b = 2;\n");

    const result = await copyTreeService.testConfig(tempDir);

    expect(result.files?.map((file) => file.path)).not.toContain("ignored.ts");
    expect(result.excluded?.total).toBeGreaterThan(0);
  });

  it("counts every previewed file the real run also emits", async () => {
    await fs.writeFile(path.join(tempDir, "package-lock.json"), JSON.stringify({ a: 1 }));
    await fs.writeFile(path.join(tempDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const preview = await copyTreeService.testConfig(tempDir);
    const real = await copyTreeService.generate(tempDir);

    expect(preview.error).toBeUndefined();
    expect(real.error).toBeUndefined();
    // The preview list drives the "N files would be included" headline, so every
    // entry in it has to actually appear in the generated document.
    for (const file of preview.files ?? []) {
      expect(real.content).toContain(file.path);
    }
    expect(preview.includedFiles).toBe(preview.files?.length);
  });

  describe("scoping to a folder", () => {
    async function buildProject() {
      await fs.writeFile(path.join(tempDir, ".gitignore"), "generated.ts\n");
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src", "kept.ts"), "export const kept = 1;\n");
      await fs.writeFile(path.join(tempDir, "src", "generated.ts"), "export const gen = 1;\n");
      // A dotfile is the case a `folder/**` glob quietly misses.
      await fs.writeFile(path.join(tempDir, "src", ".eslintrc.json"), "{}\n");
      await fs.mkdir(path.join(tempDir, "docs"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "docs", "sibling.ts"), "export const s = 1;\n");
    }

    it("selects what a whole-project run would for that subtree when no budget is set", async () => {
      await buildProject();

      const full = await copyTreeService.testConfig(tempDir);
      const scoped = await copyTreeService.testConfig(tempDir, { scopePaths: ["src"] });

      expect(scoped.error).toBeUndefined();
      // The invariant the folder context menu is supposed to hold: narrowing to
      // a folder may drop files, never add ones the full run had ruled out.
      // Neither run configures a budget, and the fixture is far under the SDK's
      // own defaults, so nothing is dropped and the two sets match exactly.
      const fullUnderSrc = (full.files ?? [])
        .map((file) => file.path)
        .filter((filePath) => filePath.startsWith("src/"))
        .sort();
      expect((scoped.files ?? []).map((file) => file.path).sort()).toEqual(fullUnderSrc);
    });

    it("applies an ignore rule declared at the project root, not just inside the folder", async () => {
      await buildProject();

      const result = await copyTreeService.testConfig(tempDir, { scopePaths: ["src"] });

      const paths = result.files?.map((file) => file.path) ?? [];
      expect(paths).toContain("src/kept.ts");
      // Root .gitignore names it, so a scoped walk starting below the root has
      // to have carried that rule down with it.
      expect(paths).not.toContain("src/generated.ts");
    });

    it("keeps everything outside the folder out and paths anchored at the project root", async () => {
      await buildProject();

      const result = await copyTreeService.testConfig(tempDir, { scopePaths: ["src"] });

      const paths = result.files?.map((file) => file.path) ?? [];
      expect(paths).not.toContain("docs/sibling.ts");
      expect(paths).not.toContain("small.ts");
      // Non-empty first, or the "all under src/" check below passes vacuously.
      expect(paths).toContain("src/kept.ts");
      // Root-relative, so an agent's @-reference to the emitted path resolves.
      expect(paths.every((filePath) => filePath.startsWith("src/"))).toBe(true);
    });

    it("includes a dotfile that a folder glob would silently skip", async () => {
      await buildProject();

      const result = await copyTreeService.testConfig(tempDir, { scopePaths: ["src"] });

      // `src/**` does not match dotfiles, so the old pattern-based folder copy
      // dropped .eslintrc/.env-style files without reporting them anywhere.
      expect(result.files?.map((file) => file.path)).toContain("src/.eslintrc.json");
    });

    it("does not account for files outside the folder as exclusions", async () => {
      await buildProject();

      const result = await copyTreeService.testConfig(tempDir, { scopePaths: ["src"] });

      // A whole-project walk narrowed by a pattern books every unmatched file
      // as `filterPattern`, which would make "why was this empty" misreport.
      expect(result.excluded?.byReason.filterPattern ?? 0).toBe(0);
      expect(result.excluded?.byReason.gitignore).toBeGreaterThan(0);
    });

    it("walks a single file target, which a folder glob turns into no match", async () => {
      await buildProject();

      const result = await copyTreeService.testConfig(tempDir, {
        scopePaths: ["src/kept.ts"],
      });

      expect(result.files?.map((file) => file.path)).toEqual(["src/kept.ts"]);
    });

    it("takes the folder name literally instead of reading it as a pattern", async () => {
      await fs.mkdir(path.join(tempDir, "src", "[draft]"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src", "[draft]", "note.ts"), "export const n = 1;\n");
      await fs.mkdir(path.join(tempDir, "src", "d"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src", "d", "other.ts"), "export const o = 1;\n");

      const result = await copyTreeService.testConfig(tempDir, { scopePaths: ["src/[draft]"] });

      const paths = result.files?.map((file) => file.path) ?? [];
      expect(paths).toContain("src/[draft]/note.ts");
      // As a glob character class `[draft]` also matches `src/d`; as a literal
      // path it must not.
      expect(paths).not.toContain("src/d/other.ts");
    });

    it("explains an excluded folder as an exclusion rather than an empty result", async () => {
      await fs.mkdir(path.join(tempDir, "node_modules", "left-pad"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "node_modules", "left-pad", "index.js"),
        "module.exports = 1;\n"
      );

      const result = await copyTreeService.testConfig(tempDir, { scopePaths: ["node_modules"] });

      expect(result.error).toBeUndefined();
      expect(result.includedFiles).toBe(0);
      expect(result.noFilesMatched).toBe(true);
      // The renderer's "why is this empty" toast reads byReason, so a pruned
      // folder has to be accounted for rather than vanishing silently.
      expect(result.excluded?.total).toBeGreaterThan(0);
    });

    it("reports a scoped path that doesn't exist as a sanitized error", async () => {
      const result = await copyTreeService.testConfig(tempDir, { scopePaths: ["does/not/exist"] });

      expect(result.error).toBeTruthy();
      // Never the SDK's own message — it carries the absolute path.
      expect(result.error).not.toContain(tempDir);
    });

    it("blames the folder, not the project, when only the folder is missing", async () => {
      const missingFolder = await copyTreeService.testConfig(tempDir, {
        scopePaths: ["does/not/exist"],
      });
      const missingProject = await copyTreeService.testConfig(
        path.join(tempDir, "no-such-project")
      );

      // The SDK reuses ERR_PATH_NOT_FOUND for both, so a shared message would
      // send someone with a stale tree row off checking their project setup.
      expect(missingFolder.error).not.toBe(missingProject.error);
      expect(missingFolder.error).toMatch(/folder/i);
    });
  });

  it("reports truncation when a character budget bites", async () => {
    await writeSized("wide.ts", 20_000);

    const result = await copyTreeService.testConfig(tempDir, { charLimit: 500 });

    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  describe("context file tree", () => {
    it("lists a folder that is not a git repository", async () => {
      // The old `git check-ignore` listing needed a repository and failed closed
      // — an empty tree — without one. CopyTree reads ignore files as plain
      // files, so a bare folder lists normally (#11439, and the non-git
      // workspaces in #11405).
      const nodes = await copyTreeService.getFileTree(tempDir);

      expect(nodes.map((node) => node.name)).toContain("small.ts");
    });

    it("honours a .gitignore with no git repository present", async () => {
      await fs.writeFile(path.join(tempDir, "ignored.ts"), "export const b = 2;\n");

      // Prove the file is visible first, so the assertion below can only pass
      // because the .gitignore took effect — not because something else in the
      // exclusion stack was already hiding it.
      const before = await copyTreeService.getFileTree(tempDir);
      expect(before.map((node) => node.name)).toContain("ignored.ts");

      await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored.ts\n");
      const after = await copyTreeService.getFileTree(tempDir);

      expect(after.map((node) => node.name)).toContain("small.ts");
      expect(after.map((node) => node.name)).not.toContain("ignored.ts");
    });

    it("keeps .git and node_modules out of the listing", async () => {
      // The old listing special-cased `.git` by name. Now CopyTree simply never
      // descends into either, so both vanish with no name checks in our code —
      // this pins that against the real exclusion stack, not a stubbed manifest.
      await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "node_modules", "pkg", "index.js"),
        "module.exports={}"
      );

      const nodes = await copyTreeService.getFileTree(tempDir);
      const names = nodes.map((node) => node.name);

      expect(names).toContain("small.ts");
      expect(names).not.toContain(".git");
      expect(names).not.toContain("node_modules");
    });

    it("omits every excluded path from the manifest instead of reporting a reason", async () => {
      // The listing's whole verdict rests on this: CopyTree records only what
      // survived, so "absent from the manifest" is the exclusion signal and
      // there is no per-entry reason to surface. That is why `FileTreeNode` has
      // `excluded` but no reason field. If a future CopyTree starts reporting
      // `excluded:*` entries this test fails — which is the signal to revisit
      // that decision, not a regression.
      await fs.writeFile(path.join(tempDir, ".gitignore"), "hidden.ts\n");
      await fs.writeFile(path.join(tempDir, "hidden.ts"), "export const h = 1;\n");
      // Names chosen so path order is unambiguous: `a-kept.ts` wins the budget
      // of one and `z-dropped.ts` loses it.
      await fs.writeFile(path.join(tempDir, "a-kept.ts"), "export const k = 1;\n");
      await fs.writeFile(path.join(tempDir, "z-dropped.ts"), "export const d = 1;\n");

      const result = await copyTreeService.testConfig(tempDir, { maxFileCount: 1, sort: "path" });

      const paths = result.files?.map((file) => file.path) ?? [];
      expect(paths).toEqual(["a-kept.ts"]);
      // Neither the ignore-excluded file nor the budget loser is reported at all.
      expect(paths).not.toContain("hidden.ts");
      expect(paths).not.toContain("z-dropped.ts");
      // Both exclusions are counted, so they were genuinely evaluated and
      // dropped rather than never seen.
      expect(result.excluded?.byReason.gitignore).toBeGreaterThan(0);
      expect(result.excluded?.byReason.fileCountBudget).toBeGreaterThan(0);
    });

    it("hides what the config excludes, which git knows nothing about", async () => {
      // The gap the issue calls out: the config's excluded-file list and binary
      // classification drop files no gitignore mentions.
      await fs.writeFile(path.join(tempDir, ".env"), "SECRET=1\n");
      await fs.writeFile(path.join(tempDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));

      const nodes = await copyTreeService.getFileTree(tempDir);
      const names = nodes.map((node) => node.name);

      expect(names).toContain("small.ts");
      expect(names).not.toContain(".env");
      expect(names).not.toContain("logo.png");
    });

    it("surfaces the excluded entries on request, flagged", async () => {
      await fs.writeFile(path.join(tempDir, ".env"), "SECRET=1\n");

      const nodes = await copyTreeService.getFileTree(tempDir, "", {}, { includeExcluded: true });

      expect(nodes.find((node) => node.name === ".env")).toMatchObject({ excluded: true });
      expect(nodes.find((node) => node.name === "small.ts")?.excluded).toBeUndefined();
    });

    it("agrees with the real run about a file the size gate drops", async () => {
      await writeSized("big.ts", 300 * 1024);

      const nodes = await copyTreeService.getFileTree(tempDir, "", { maxFileSize: 100 * 1024 });
      const real = await copyTreeService.generate(tempDir, { maxFileSize: 100 * 1024 });

      expect(nodes.map((node) => node.name)).not.toContain("big.ts");
      expect(real.content).not.toContain("big.ts");
    });

    it("lets an always pattern put a size-gated file back in the listing", async () => {
      await writeSized("big.ts", 300 * 1024);

      const nodes = await copyTreeService.getFileTree(tempDir, "", {
        maxFileSize: 100 * 1024,
        always: ["big.ts"],
      });

      expect(nodes.map((node) => node.name)).toContain("big.ts");
    });

    it("applies a global budget to a nested listing, as the real run would", async () => {
      // This is why the dry run covers the whole root instead of scoping to the
      // listed directory. `maxFileCount` is applied after discovery, so a run
      // scoped to `sub` would recompute the winner from that subtree alone and
      // list `sub/z.ts` — a file the real run drops.
      await fs.mkdir(path.join(tempDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "sub", "z.ts"), "export const z = 1;\n");

      const options = { maxFileCount: 1, sort: "path" as const };
      // Opt in to the excluded entries so this asserts a positive fact about
      // `z.ts` — a listing that returned nothing at all would otherwise pass.
      const nodes = await copyTreeService.getFileTree(tempDir, "sub", options, {
        includeExcluded: true,
      });
      const real = await copyTreeService.generate(tempDir, options);

      expect(real.content).toContain("small.ts");
      expect(real.content).not.toContain("sub/z.ts");
      // Scoping to `sub` would discover only `sub/z.ts`, so the budget of 1
      // would keep it and this flips to `excluded: undefined`.
      expect(nodes.find((node) => node.name === "z.ts")).toMatchObject({ excluded: true });
    });

    it("lists exactly the files the real run emits", async () => {
      await fs.writeFile(path.join(tempDir, "package-lock.json"), JSON.stringify({ a: 1 }));
      await fs.writeFile(path.join(tempDir, ".gitignore"), "skipped.ts\n");
      await fs.writeFile(path.join(tempDir, "skipped.ts"), "export const s = 1;\n");
      await fs.writeFile(path.join(tempDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));

      const nodes = await copyTreeService.getFileTree(tempDir);
      const real = await copyTreeService.generate(tempDir);
      // An independent dry run is the source of truth for "what the run keeps",
      // so the listing can be compared as a set rather than one direction.
      const preview = await copyTreeService.testConfig(tempDir);

      expect(real.error).toBeUndefined();
      const listed = nodes.filter((node) => !node.isDirectory).map((node) => node.path);
      // The listing covers one directory; the dry run covers the whole root, so
      // compare against its top-level entries.
      const kept = (preview.files ?? [])
        .map((file) => file.path)
        .filter((filePath) => !filePath.includes("/"));

      // The whole point of the change, in both directions: nothing the listing
      // shows is missing from the document, and nothing the document carries is
      // missing from the listing. A listing of `[]` fails the second half.
      expect([...listed].sort()).toEqual([...kept].sort());
      expect(listed).toContain("small.ts");
      expect(listed).not.toContain("skipped.ts");
      for (const filePath of listed) {
        expect(real.content).toContain(filePath);
      }
    });

    it("hides a directory whose only contents are excluded", async () => {
      await fs.writeFile(path.join(tempDir, ".gitignore"), "logs/\n");
      await fs.mkdir(path.join(tempDir, "logs"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "logs", "run.log"), "noise\n");

      const nodes = await copyTreeService.getFileTree(tempDir);

      expect(nodes.map((node) => node.name)).not.toContain("logs");
    });
  });
});
