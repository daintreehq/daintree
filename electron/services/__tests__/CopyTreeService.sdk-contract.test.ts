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

    // #11750. `.copytreeignore` is layered at every depth on every SDK code
    // path, with no option or config key that drops it, so "bypass the ignore
    // file" is not literally expressible. What IS exposed is the ignore-FILE
    // escape for a named subtree, and these pin how much it lifts — because the
    // alternative (promoting the selection into `always`) globs with
    // `ignore: []` and then outranks the caller's own `exclude`, which is the
    // reason it was rejected. Run against the installed package: every claim in
    // the wire description is a claim about the SDK, not about our adapter.
    describe("bypassing an ignore file that blocks a scoped path", () => {
      async function buildIgnoredDocs() {
        // One file, two rules: `docs/` stands between the root and the
        // selection, `*.secret` does not. Both live in the same ignore file, so
        // a bypass that dropped the file wholesale would take `*.secret` with it.
        await fs.writeFile(path.join(tempDir, ".copytreeignore"), "docs/\n*.secret\n");
        await fs.mkdir(path.join(tempDir, "docs"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "docs", "guide.md"), "# guide\n");
        await fs.writeFile(path.join(tempDir, "docs", "key.secret"), "shhh\n");
      }

      it("drops the scoped folder by default, and returns it when the bypass is on", async () => {
        await buildIgnoredDocs();

        const obeyed = await copyTreeService.testConfig(tempDir, { scopePaths: ["docs"] });
        const bypassed = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["docs"],
          scopeIgnoresIgnoreFiles: true,
        });

        // Paired rather than asserted alone: the default half is what proves the
        // fixture's rule actually bites, so the bypass half cannot pass for the
        // wrong reason (an unwritten ignore file would satisfy it silently).
        expect(obeyed.files?.map((file) => file.path) ?? []).not.toContain("docs/guide.md");
        expect(bypassed.files?.map((file) => file.path)).toContain("docs/guide.md");
      });

      it("lifts only the rule that blocked the way in, not the rest of the file", async () => {
        await buildIgnoredDocs();

        const result = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["docs"],
          scopeIgnoresIgnoreFiles: true,
        });

        const paths = result.files?.map((file) => file.path) ?? [];
        expect(paths).toContain("docs/guide.md");
        // The whole reason this is safe: `*.secret` never stood between the root
        // and `docs`, so it survives. Dropping the layer instead of the blocking
        // rule would exfiltrate exactly the files an ignore file exists to hide.
        expect(paths).not.toContain("docs/key.secret");
      });

      it("keeps honouring an ignore file that lives inside the selection", async () => {
        await buildIgnoredDocs();
        await fs.writeFile(path.join(tempDir, "docs", ".copytreeignore"), "draft.md\n");
        await fs.writeFile(path.join(tempDir, "docs", "draft.md"), "# draft\n");

        const result = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["docs"],
          scopeIgnoresIgnoreFiles: true,
        });

        const paths = result.files?.map((file) => file.path) ?? [];
        expect(paths).toContain("docs/guide.md");
        // Rules at or below the selection describe the subtree the caller asked
        // for, so they are not what "let me in" was about.
        expect(paths).not.toContain("docs/draft.md");
      });

      it("still applies the caller's own exclude inside the unblocked folder", async () => {
        await buildIgnoredDocs();

        const result = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["docs"],
          scopeIgnoresIgnoreFiles: true,
          exclude: ["**/guide.md"],
        });

        // The single behaviour that ruled out force-including the selection:
        // `always` would have resurrected this file, since ProfileFilterStage
        // returns before it ever consults `exclude`.
        expect(result.files?.map((file) => file.path) ?? []).not.toContain("docs/guide.md");
      });

      it("still applies the per-file size gate inside the unblocked folder", async () => {
        await buildIgnoredDocs();
        await fs.writeFile(path.join(tempDir, "docs", "big.md"), "x".repeat(300 * 1024));

        const result = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["docs"],
          scopeIgnoresIgnoreFiles: true,
          maxFileSize: 100 * 1024,
        });

        const paths = result.files?.map((file) => file.path) ?? [];
        expect(paths).toContain("docs/guide.md");
        // `always` lifts the gate; this must not, or "bypass an ignore file"
        // would quietly also mean "ignore the size limit I set".
        expect(paths).not.toContain("docs/big.md");
      });

      // Both names sit in the SDK's `globalExcludedDirectories`, and they are
      // excluded by that config layer rather than by any ignore file — so the
      // bypass has nothing to lift for them even when a caller scopes straight
      // in. `build` is the one worth pinning alongside `node_modules`: it is the
      // directory a caller is most likely to scope into expecting this flag to
      // work, precisely because its own `.gitignore` usually names it too.
      it.each(["node_modules", "build"])(
        "leaves the config exclusion on %s standing, bypass or not",
        async (excludedDir) => {
          await fs.mkdir(path.join(tempDir, excludedDir, "nested"), { recursive: true });
          await fs.writeFile(
            path.join(tempDir, excludedDir, "nested", "index.js"),
            "module.exports = 1;\n"
          );

          const result = await copyTreeService.testConfig(tempDir, {
            scopePaths: [excludedDir],
            scopeIgnoresIgnoreFiles: true,
          });

          // The companion `scopeIgnoresConfigExcludes` escape is deliberately
          // never set: lifting an ignore rule is a different request from
          // dragging a dependency tree or a build output in, and only the first
          // one is on offer.
          expect(result.includedFiles).toBe(0);
        }
      );

      it("also lifts a .gitignore rule blocking the way in, which the wire text has to admit", async () => {
        // Deliberately not a name from `globalExcludedDirectories` — `build` or
        // `dist` would be held out by the config layer and this would pass
        // without the ignore rule ever being consulted.
        await fs.writeFile(path.join(tempDir, ".gitignore"), "local-notes/\n");
        await fs.mkdir(path.join(tempDir, "local-notes"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "local-notes", "todo.md"), "# todo\n");

        const obeyed = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["local-notes"],
        });
        const result = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["local-notes"],
          scopeIgnoresIgnoreFiles: true,
        });

        expect(obeyed.files?.map((file) => file.path) ?? []).not.toContain("local-notes/todo.md");
        // Pinning the over-reach, not endorsing it: the SDK's escape covers both
        // ignore files and cannot be narrowed to `.copytreeignore`. If a future
        // SDK separates them this test is what says the description must change.
        expect(result.files?.map((file) => file.path)).toContain("local-notes/todo.md");
      });

      it("scopes each named file independently, so a scattered curated bundle works", async () => {
        await buildIgnoredDocs();
        await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "src", "gen.ts"), "export const g = 1;\n");

        const result = await copyTreeService.testConfig(tempDir, {
          scopePaths: ["src/gen.ts", "docs/guide.md"],
          scopeIgnoresIgnoreFiles: true,
        });

        // The issue's actual shape: source files plus a few docs the ignore file
        // dropped. Each entry gets its own root-to-entry override, so mixing an
        // ignored path with an ordinary one needs no per-file `always` patterns.
        expect((result.files?.map((file) => file.path) ?? []).sort()).toEqual([
          "docs/guide.md",
          "src/gen.ts",
        ]);
      });
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
      // No pattern was supplied and none could have run — the walk was already
      // empty. Naming a selector here would send a caller to fix the one part
      // of its request that was correct (#11731).
      expect(result.unmatchedSelector).toBeUndefined();
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

  // The shape an assistant produces when asked for "everything relevant to X,
  // including supporting files and tests" (#11722): a handful of exact paths
  // mixed with globs, scattered across the tree rather than under one subtree.
  // `scopePaths` cannot express it — it takes literal subtrees and recomputes
  // budgets over them — so this rides entirely on `includePaths`/`filter`.
  describe("curated mixed selection", () => {
    async function writeFixture(relativePath: string, contents: string) {
      const absolute = path.join(tempDir, relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, contents);
    }

    beforeEach(async () => {
      await writeFixture("src/landscape/generator.ts", "export const GENERATOR_SENTINEL = 1;\n");
      await writeFixture("src/landscape/support/math.ts", "export const SUPPORT_SENTINEL = 1;\n");
      await writeFixture(
        "src/landscape/support/nested/seed.ts",
        "export const NESTED_SENTINEL = 1;\n"
      );
      await writeFixture("tests/landscape/generator.test.ts", "export const TEST_SENTINEL = 1;\n");
      // Decoys: same tree, same extensions, deliberately unselected.
      await writeFixture("src/landscape/preview.ts", "export const PREVIEW_DECOY = 1;\n");
      await writeFixture("tests/terrain.test.ts", "export const TERRAIN_DECOY = 1;\n");
      await writeFixture("docs/landscape.md", "# decoy\n");
    });

    const CURATED = [
      "src/landscape/generator.ts",
      "src/landscape/support/**/*.ts",
      "tests/landscape/*.test.ts",
    ];

    it("selects exact paths and globs together, and nothing else", async () => {
      const result = await copyTreeService.testConfig(tempDir, { includePaths: CURATED });

      expect(result.error).toBeUndefined();
      expect((result.files ?? []).map((file) => file.path).sort()).toEqual([
        "src/landscape/generator.ts",
        "src/landscape/support/math.ts",
        "src/landscape/support/nested/seed.ts",
        "tests/landscape/generator.test.ts",
      ]);
      // Exclusion accounting: files were walked and then ruled out by the
      // pattern, so the count above is a filtered result rather than an empty
      // traversal. (The exact-list assertion is what proves the selection; this
      // catches the accounting going silent.)
      expect(result.excluded?.byReason.filterPattern).toBeGreaterThan(0);
      // ...and that same count is why blame is gated on `noFilesMatched` too:
      // this run succeeded, so nothing is to blame for it (#11731).
      expect(result.unmatchedSelector).toBeUndefined();
    });

    // The failure #11731 traced, reproduced against the real SDK: every path a
    // caller sent named a directory that exists, and the run came back empty
    // with no error and nothing to correct.
    it("blames the patterns when a bare directory selects nothing", async () => {
      const result = await copyTreeService.testConfig(tempDir, {
        includePaths: ["src/landscape"],
      });

      // The directory is real — the same fixture the curated selection above
      // pulls four files out of — so "no such path" is not the explanation.
      expect(result.error).toBeUndefined();
      expect(result.includedFiles).toBe(0);
      expect(result.noFilesMatched).toBe(true);
      // Files reached the pattern check and every one was rejected there, which
      // is what makes the patterns rather than the traversal the culprit.
      expect(result.excluded?.byReason.filterPattern).toBeGreaterThan(0);
      expect(result.unmatchedSelector).toBe("includePaths");
    });

    it("blames neither selector when the glob form of the same folder works", async () => {
      // The remedy the description now prescribes has to actually be the
      // remedy, or the hint sends callers somewhere that fails the same way.
      const result = await copyTreeService.testConfig(tempDir, {
        includePaths: ["src/landscape/**"],
      });

      // The deepest fixture file specifically: a `/**` that regressed to direct
      // children only would still leave `includedFiles` non-zero, so a count
      // check alone would not notice the folder remedy half-working.
      expect(result.files?.map((file) => file.path)).toContain(
        "src/landscape/support/nested/seed.ts"
      );
      expect(result.noFilesMatched).toBeFalsy();
      expect(result.unmatchedSelector).toBeUndefined();
    });

    // `noFilesMatched` is `files.length === 0` measured once the whole pipeline
    // has run, and the size gate, the git filter and the budgets all run after
    // the pattern check. So "some file failed the patterns" and "the run came
    // back empty" can both be true while the patterns matched perfectly — the
    // decoys supply the first, a later stage removes the real match. Blaming
    // the patterns there would send a caller to rewrite the one field that
    // worked, which is #11731 pointed the other way.
    describe("a later stage, not the patterns, emptying the run", () => {
      it("stays quiet when the size gate dropped the only match", async () => {
        // The pattern selects exactly one real file; the gate then rejects it,
        // while the unselected decoys have already been booked as filterPattern.
        const result = await copyTreeService.testConfig(tempDir, {
          includePaths: ["src/landscape/generator.ts"],
          maxFileSize: 1,
        });

        expect(result.noFilesMatched).toBe(true);
        // The precondition that makes this test meaningful: without it the run
        // could be empty for some third reason and pass vacuously.
        expect(result.excluded?.byReason.filterPattern).toBeGreaterThan(0);
        expect(result.excluded?.byReason.sizeGate).toBeGreaterThan(0);
        expect(result.unmatchedSelector).toBeUndefined();
      });

      // The git filter is the other post-pattern stage that can empty a run
      // this way, but reaching it needs a real repository with a real diff.
      // Its mapping is covered by the mocked `gitFilter` row in
      // CopyTreeService.test.ts; the size gate above is what proves the
      // post-pattern rule against the real pipeline, so a git fixture here
      // would add process spawning without adding a distinct guarantee.
    });

    it("still blames a bare directory on a repo that has configured excludes", async () => {
      // `exclude` is installed as an ignore LAYER on the walker, so it prunes
      // before the patterns are consulted and proves nothing about them. It is
      // also not optional in practice: the IPC handler folds a project's
      // `excludedPaths` and `alwaysExclude` into `exclude` whenever the caller
      // omits it, so treating its accounting as post-pattern would silence the
      // #11731 diagnostic on exactly the configured repositories that need it.
      const result = await copyTreeService.testConfig(tempDir, {
        includePaths: ["src/landscape"],
        exclude: ["docs/**"],
      });

      expect(result.noFilesMatched).toBe(true);
      // The precondition: the exclude really did book entries, so this is not
      // passing because the layer never fired.
      expect(result.excluded?.byReason.optionExclude).toBeGreaterThan(0);
      expect(result.unmatchedSelector).toBe("includePaths");
    });

    it("carries the curated files, and only those, into a real generated bundle", async () => {
      const result = await copyTreeService.generate(tempDir, { includePaths: CURATED });

      expect(result.error).toBeUndefined();
      expect(result.fileCount).toBe(4);
      for (const sentinel of [
        "GENERATOR_SENTINEL",
        "SUPPORT_SENTINEL",
        "NESTED_SENTINEL",
        "TEST_SENTINEL",
      ]) {
        expect(result.content).toContain(sentinel);
      }
      for (const decoy of ["PREVIEW_DECOY", "TERRAIN_DECOY"]) {
        expect(result.content).not.toContain(decoy);
      }
    });

    // The regression for the `||` collapse: `includePaths` used to win outright,
    // so a caller that split its selection across both fields silently lost the
    // `filter` half with no error and no diagnostic (#11722).
    it("unions includePaths with filter instead of letting one win", async () => {
      const result = await copyTreeService.testConfig(tempDir, {
        includePaths: ["src/landscape/generator.ts"],
        filter: ["tests/landscape/*.test.ts"],
      });

      expect(result.error).toBeUndefined();
      expect((result.files ?? []).map((file) => file.path).sort()).toEqual([
        "src/landscape/generator.ts",
        "tests/landscape/generator.test.ts",
      ]);
    });

    it("accepts a bare string filter alongside includePaths", async () => {
      const result = await copyTreeService.testConfig(tempDir, {
        includePaths: ["src/landscape/generator.ts"],
        filter: "tests/landscape/*.test.ts",
      });

      expect((result.files ?? []).map((file) => file.path).sort()).toEqual([
        "src/landscape/generator.ts",
        "tests/landscape/generator.test.ts",
      ]);
    });

    // KNOWN UPSTREAM GAP, not a Daintree one: a curated glob cannot reach a
    // dotfile. CopyTree 0.17 builds its include matcher as
    // `micromatch.matcher(this.patterns)` (FileDiscoveryStage.js:485) with no
    // `dot: true`, while the force-include matcher three lines up
    // (FileDiscoveryStage.js:472) sets it — so `always` sees dotfiles and
    // `filter`/`includePaths` do not. That costs a curated bundle things like
    // `.github/workflows/**` or a dotfile config; ordinary sources and tests,
    // which is what the feature is for, are unaffected.
    //
    // Pinned as current behavior rather than `it.fails`, which flips ANY
    // failure to green — a broken fixture write or a renamed option would have
    // "passed" it forever. The non-dot control is what makes this honest: it
    // proves the glob and the traversal work, so the dotfile's absence is the
    // upstream gap and not a typo. When a copytree release with `{ dot: true }`
    // lands and this repo's dependency is raised to it, the second assertion
    // starts failing — flip it to `toContain` and delete this comment.
    it("does not reach a dotfile through a curated glob (upstream copytree gap)", async () => {
      await writeFixture("config/landscape/.defaults.json", '{"DOTFILE_SENTINEL":1}\n');
      await writeFixture("config/landscape/visible.json", '{"CONTROL_SENTINEL":1}\n');

      const result = await copyTreeService.testConfig(tempDir, {
        includePaths: ["config/landscape/**"],
      });

      expect(result.error).toBeUndefined();
      const selected = (result.files ?? []).map((file) => file.path);
      expect(selected).toContain("config/landscape/visible.json");
      expect(selected).not.toContain("config/landscape/.defaults.json");
    });

    it("still selects everything when neither field is given", async () => {
      const result = await copyTreeService.testConfig(tempDir, {});

      expect((result.files ?? []).map((file) => file.path)).toContain("src/landscape/preview.ts");
    });

    // The merge must never widen a selection. An absent filter means "the whole
    // worktree" to the SDK, so a supplied-but-unmatchable selection that got
    // normalized away would put the entire repo on the user's clipboard — the
    // opposite of what the caller asked for, and worst exactly when an
    // assistant emits a malformed list.
    it("copies nothing, not everything, when the selection matches nothing", async () => {
      const result = await copyTreeService.testConfig(tempDir, {
        includePaths: ["does/not/exist/**"],
      });

      const selected = (result.files ?? []).map((file) => file.path);
      expect(selected).toEqual([]);
      expect(selected).not.toContain("src/landscape/preview.ts");
    });

    it("treats a blank pattern as unmatchable rather than as no selection", async () => {
      // Both validated boundaries reject a blank entry before this point; if one
      // ever reaches the service it must still fail closed rather than widen.
      const result = await copyTreeService.testConfig(tempDir, { includePaths: [""] });

      expect((result.files ?? []).map((file) => file.path)).not.toContain(
        "src/landscape/preview.ts"
      );
    });

    // An empty array cannot express "select nothing" to the SDK — it reads as
    // "no filter" and copies everything — which is why the schemas reject it
    // rather than the service trying to render it harmless.
    it("documents that an empty selection array would widen, hence the schema guard", async () => {
      const result = await copyTreeService.testConfig(tempDir, { includePaths: [] });

      expect((result.files ?? []).map((file) => file.path)).toContain("src/landscape/preview.ts");
    });
  });
});
