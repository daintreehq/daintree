import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const simpleGitMock = vi.hoisted(() => vi.fn());
const gitClientMock: {
  env: ReturnType<typeof vi.fn>;
  checkIsRepo: ReturnType<typeof vi.fn>;
  revparse: ReturnType<typeof vi.fn>;
  raw: ReturnType<typeof vi.fn>;
} = vi.hoisted(() => ({
  env: vi.fn(),
  checkIsRepo: vi.fn<() => Promise<boolean>>(),
  revparse: vi.fn<(args: string[]) => Promise<string>>(),
  raw: vi.fn<(args: string[]) => Promise<string>>(),
}));
gitClientMock.env.mockReturnValue(gitClientMock);

vi.mock("simple-git", () => ({
  simpleGit: simpleGitMock,
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "daintree-file-search-"));
}

function writeFile(filePath: string, content = "x"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

describe("FileSearchService", () => {
  const tempDirs: string[] = [];
  const services: Array<{ dispose: () => void }> = [];

  // The cache decides expiry against `Date.now()`, so the TTL tests move the
  // clock rather than sleep. Offset zero is a pass-through, so every other test
  // in this file sees the real clock; full fake timers are avoided because the
  // service awaits real git and fs work.
  const realDateNow = Date.now;
  let clockOffsetMs = 0;
  let frozenNowMs: number | null = null;

  function advanceClock(ms: number): void {
    clockOffsetMs += ms;
  }

  /**
   * Stop real time as well as offsetting it. An offset alone cannot pin an exact
   * expiry boundary: real milliseconds elapse between writing the entry and
   * reading it back, so a `now === expiresAt` probe lands just past the edge.
   */
  function freezeClock(): void {
    frozenNowMs = realDateNow.call(Date);
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    clockOffsetMs = 0;
    frozenNowMs = null;
    Date.now = () => (frozenNowMs ?? realDateNow.call(Date)) + clockOffsetMs;
    simpleGitMock.mockImplementation(() => gitClientMock);
    gitClientMock.env.mockReturnValue(gitClientMock);
    gitClientMock.checkIsRepo.mockResolvedValue(false);
    gitClientMock.revparse.mockRejectedValue(new Error("not a git repository"));
    // A non-repository cwd: `ls-files` exits non-zero, which is what sends the
    // service to the disk walker. An empty successful listing means "all ignored".
    gitClientMock.raw.mockRejectedValue(
      new Error("fatal: not a git repository (or any of the parent directories): .git")
    );
  });

  afterEach(() => {
    Date.now = realDateNow;
    // `vi.resetModules()` hands the next test a fresh module — and a fresh
    // handle to a sweep interval the old module already armed. Disposing here
    // is what keeps those from accumulating across the file.
    for (const service of services) service.dispose();
    services.length = 0;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function createService() {
    const { FileSearchService } = await import("../FileSearchService.js");
    const service = new FileSearchService();
    services.push(service);
    return service;
  }

  /**
   * Hold the next git listing open, and signal when the load actually reaches
   * it. `loadFileList` awaits an fs.stat and the hardened-git construction
   * first, so a test that invalidates without waiting for this signal is acting
   * before the load is genuinely in flight and proves nothing.
   */
  function deferGitListing(): {
    reached: Promise<void>;
    release: (listing: string) => void;
  } {
    let release!: (listing: string) => void;
    let markReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    gitClientMock.raw.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
          markReached();
        })
    );
    return { reached, release: (listing: string) => release(listing) };
  }

  function gitRepo(dir: string, listing: string): void {
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue(listing);
  }

  it("returns empty results when cwd does not exist", async () => {
    const service = await createService();
    const missingDir = path.join(os.tmpdir(), "daintree-does-not-exist", `${Date.now()}`);

    await expect(service.search({ cwd: missingDir, query: "readme" })).resolves.toEqual([]);
  });

  it("returns empty results when cwd is a file path", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const filePath = path.join(dir, "README.md");
    writeFile(filePath, "hello");

    const service = await createService();
    const result = await service.search({ cwd: filePath, query: "readme" });

    expect(result).toEqual([]);
  });

  it("falls back to filesystem traversal when cwd is not a git repo", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFile(path.join(dir, "README.md"));
    writeFile(path.join(dir, "src", "app.ts"));
    writeFile(path.join(dir, "docs", "guide.md"));

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "app", limit: 10 });

    expect(result).toContain("src/app.ts");
    expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
  });

  it("takes an empty successful listing as the answer instead of walking the disk", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFile(path.join(dir, "private.txt"));
    writeFile(path.join(dir, "src", "app.ts"));
    gitRepo(dir, "");

    const service = await createService();

    await expect(service.search({ cwd: dir, query: "", limit: 10 })).resolves.toEqual([]);
    await expect(service.listFiles(dir)).resolves.toEqual([]);
  });

  it("normalizes leading path syntax in queries", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("src/components/Button.tsx\0src/components/Input.tsx\0");

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "./src//components//button", limit: 5 });

    expect(result).toEqual(["src/components/Button.tsx"]);
  });

  it("returns shortest paths first when query is empty", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("src/components/Button.tsx\0a.ts\0README.md\0");

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "", limit: 3 });

    expect(result).toEqual(["a.ts", "src/", "README.md"]);
  });

  describe("files only", () => {
    it("fills the limit with files when short folder names would crowd them out", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "a/x/deep-file.ts\0b/y/deep-file.ts\0top-level-file.ts\0");
      const service = await createService();

      expect(await service.search({ cwd: dir, query: "", limit: 3 })).toEqual(["a/", "b/", "a/x/"]);
      expect(await service.search({ cwd: dir, query: "", limit: 3, filesOnly: true })).toEqual([
        "a/x/deep-file.ts",
        "b/y/deep-file.ts",
        "top-level-file.ts",
      ]);
    });

    it("fills an empty query's page with files past more than a page of folders", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const listing = Array.from(
        { length: 120 },
        (_, i) => `d${String(i).padStart(3, "0")}/a-much-longer-file-name.ts`
      );
      gitRepo(dir, `${listing.join("\0")}\0`);
      const service = await createService();

      const page = await service.search({ cwd: dir, query: "", limit: 5, filesOnly: true });
      expect(page).toEqual(listing.slice(0, 5));
    });

    it("leaves folders out of a typed search, and the next search still finds them", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "docs/docs-index.md\0docs/guide/docs-guide.md\0");
      const service = await createService();

      // A folder would take the one slot without filesOnly.
      expect(await service.search({ cwd: dir, query: "doc", limit: 1 })).toEqual(["docs/"]);
      service.invalidate(dir);
      const files = await service.search({ cwd: dir, query: "doc", limit: 1, filesOnly: true });
      expect(files).toHaveLength(1);
      expect(files[0]?.endsWith("/")).toBe(false);
      // "docs" narrows from the files-only search's candidates.
      const all = await service.search({ cwd: dir, query: "docs", limit: 10 });
      expect(all).toContain("docs/");
    });
  });

  describe("empty-query ranking", () => {
    const collator = new Intl.Collator();

    // The order the service has always promised: length, then locale, with
    // collator ties left in listing order by the stable sort.
    function fullSort(files: readonly string[]): string[] {
      return [...files].sort((a, b) => a.length - b.length || collator.compare(a, b));
    }

    function seededRng(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
    }

    // A tiny alphabet keeps hundreds of paths on a handful of lengths, so most
    // comparisons reach the collator, and each pair here is one the collator
    // calls equal at equal length (canonical singletons and their targets).
    const ALPHABET = ["a", "b", "_", "\u212B", "\u00C5", "\u2126", "\u03A9", "\u212A", "K"];

    function randomListing(rng: () => number, count: number): string[] {
      const paths: string[] = [];
      for (let i = 0; i < count; i++) {
        const segments = 1 + Math.floor(rng() * 3);
        const parts: string[] = [];
        for (let s = 0; s < segments; s++) {
          const length = 1 + Math.floor(rng() * 3);
          let part = "";
          for (let c = 0; c < length; c++) part += ALPHABET[Math.floor(rng() * ALPHABET.length)];
          parts.push(part);
        }
        paths.push(parts.join("/"));
      }
      return paths;
    }

    it("matches the full stable sort at limits 1, 50 and 100", async () => {
      for (let seed = 1; seed <= 20; seed++) {
        const dir = makeTempDir();
        tempDirs.push(dir);
        gitRepo(dir, `${randomListing(seededRng(seed), 400).join("\0")}\0`);
        const service = await createService();

        const pages = new Map<number, string[]>();
        for (const limit of [1, 50, 100]) {
          service.invalidate(dir);
          pages.set(limit, await service.search({ cwd: dir, query: "", limit }));
        }
        const expected = fullSort(await service.listFiles(dir));

        expect(expected.length).toBeGreaterThan(100);
        for (const [limit, page] of pages) {
          expect(page, `seed ${seed} limit ${limit}`).toEqual(expected.slice(0, limit));
        }
      }
    });

    it("keeps paths the collator calls equal in listing order across the cutoff", async () => {
      const angstrom = "\u212B.ts";
      const ring = "\u00C5.ts";
      expect(angstrom).not.toBe(ring);
      expect(collator.compare(angstrom, ring)).toBe(0);
      // Ninety-nine shorter names fill the page ahead of the pair, so only the
      // first-listed of the two fits, and the heap has to evict one of them.
      const shorter = Array.from({ length: 99 }, (_, i) => String(i).padStart(3, "0"));

      for (const [first, second] of [
        [angstrom, ring],
        [ring, angstrom],
      ]) {
        const dir = makeTempDir();
        tempDirs.push(dir);
        gitRepo(dir, `${[first, second, ...shorter].join("\0")}\0`);
        const service = await createService();
        const page = await service.search({ cwd: dir, query: "", limit: 100 });

        expect(page.slice(0, 99)).toEqual(shorter);
        expect(page[99]).toBe(first);
      }
    });

    it("serves every limit as a prefix of one ranking without reloading", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const listing = randomListing(seededRng(99), 300);
      gitRepo(dir, `${listing.join("\0")}\0`);
      const service = await createService();

      // Cold at the smallest page: a ranking cut at the requested limit would
      // leave nothing to serve the larger pages from.
      const one = await service.search({ cwd: dir, query: "", limit: 1 });
      const hundred = await service.search({ cwd: dir, query: "", limit: 100 });
      const fifty = await service.search({ cwd: dir, query: "", limit: 50 });

      expect(hundred).toHaveLength(100);
      expect(fifty).toEqual(hundred.slice(0, 50));
      expect(one).toEqual(hundred.slice(0, 1));
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      hundred.reverse();
      fifty.length = 0;
      await expect(service.search({ cwd: dir, query: "", limit: 100 })).resolves.toEqual(
        [...hundred].reverse()
      );
    });

    it("leaves the listing handed to listFiles unsorted", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "src/components/Button.tsx\0a.ts\0README.md\0");
      const service = await createService();

      await service.search({ cwd: dir, query: "", limit: 3 });

      expect(await service.listFiles(dir)).toEqual([
        "src/components/Button.tsx",
        "a.ts",
        "README.md",
        "src/components/",
        "src/",
      ]);
    });
  });

  describe("result limit consistency", () => {
    // Git lists paths in byte order, which puts `appZ` ahead of `app_a`; the
    // ranking breaks score ties by locale order, which puts `app_a` first. The
    // tie that loses on locale order must not win just by arriving first.
    const listing = "appZ.ts\0app_a.ts\0lib/app.ts\0src/apple.ts\0src/apply.ts\0";

    async function searchAt(query: string, limits: number[]): Promise<string[][]> {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, listing);
      const service = await createService();
      const pages: string[][] = [];
      for (const limit of limits) {
        service.invalidate(dir);
        pages.push(await service.search({ cwd: dir, query, limit }));
      }
      return pages;
    }

    it("keeps the earlier-collating file when a same-score tie arrives after the page is full", async () => {
      const [one, two] = await searchAt("app", [1, 2]);

      expect(two).toEqual(["app_a.ts", "appZ.ts"]);
      expect(one).toEqual(["app_a.ts"]);
    });

    it("returns a prefix of the full ranking at every limit", async () => {
      const limits = [1, 2, 3, 4, 5, 100];
      const pages = await searchAt("app", limits);
      const full = pages[pages.length - 1];

      expect(full).toHaveLength(5);
      limits.forEach((limit, i) => {
        expect(pages[i]).toEqual(full.slice(0, limit));
      });
    });

    it("ranks a narrowed search the same as a fresh one", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, listing);
      const service = await createService();
      await service.search({ cwd: dir, query: "ap", limit: 1 });
      const narrowed = await service.search({ cwd: dir, query: "app", limit: 1 });

      const [fresh] = await searchAt("app", [1]);
      expect(narrowed).toEqual(fresh);
      expect(narrowed).toEqual(["app_a.ts"]);
    });

    it("stays consistent across limits on a warm index", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, listing);
      const service = await createService();

      const one = await service.search({ cwd: dir, query: "app", limit: 1 });
      const two = await service.search({ cwd: dir, query: "app", limit: 2 });
      const again = await service.search({ cwd: dir, query: "app", limit: 1 });

      expect(two).toEqual(["app_a.ts", "appZ.ts"]);
      expect(one).toEqual(["app_a.ts"]);
      expect(again).toEqual(one);
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
    });

    it("evicts the true worst entry after a replacement", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "appZ.ts\0appY.ts\0app_b.ts\0app_a.ts\0");
      const service = await createService();

      await expect(service.search({ cwd: dir, query: "app", limit: 2 })).resolves.toEqual([
        "app_a.ts",
        "app_b.ts",
      ]);
    });

    it("orders paths the collator calls equal the same way whichever arrives first", async () => {
      const nfc = "app_é.ts";
      const nfd = "app_é.ts";
      const results: string[][] = [];
      for (const order of [`${nfc}\0${nfd}\0`, `${nfd}\0${nfc}\0`]) {
        const dir = makeTempDir();
        tempDirs.push(dir);
        gitRepo(dir, order);
        const service = await createService();
        results.push(await service.search({ cwd: dir, query: "app", limit: 1 }));
        results.push(await service.search({ cwd: dir, query: "app", limit: 2 }));
      }

      expect(results).toEqual([[nfd], [nfd, nfc], [nfd], [nfd, nfc]]);
    });
  });

  describe("searchNaturalLanguage", () => {
    it("resolves 'hybrid input bar component' to HybridInputBar.tsx", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue(
        "src/components/HybridInputBar.tsx\0src/components/Button.tsx\0src/App.tsx\0"
      );

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "hybrid input bar component",
        limit: 5,
      });

      expect(result[0]).toBe("src/components/HybridInputBar.tsx");
    });

    it("returns empty array for query with only stop words", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/App.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "the component file",
        limit: 5,
      });

      expect(result).toEqual([]);
    });

    it("skips directory entries", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/app/App.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "app",
        limit: 5,
      });

      expect(result).toEqual(["src/app/App.tsx"]);
      expect(result.every((r) => !r.endsWith("/"))).toBe(true);
    });

    it("handles snake_case and kebab-case filenames", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue(
        "src/voice_recording_service.ts\0src/file-search-service.ts\0src/other.ts\0"
      );

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "voice recording service",
        limit: 5,
      });

      expect(result[0]).toBe("src/voice_recording_service.ts");
    });

    it("does not match short tokens against unrelated longer words", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/useEffect.tsx\0src/UserSettings.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "us settings",
        limit: 5,
      });

      // "us" is short and must not loose-match "useEffect"; only "settings" matches
      // "Settings" in UserSettings (1/2 = 0.5 score), useEffect has no matches.
      expect(result).toEqual(["src/UserSettings.tsx"]);
    });

    it("ranks S3Client.ts above Client.ts when query is 's3 client'", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/Client.ts\0src/S3Client.ts\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "s3 client",
        limit: 5,
      });

      // Without query-side digit splitting, "s3" never matches and Client.ts
      // ties or beats S3Client.ts on path length. After the fix, query tokens
      // become ["s", "3", "client"] which fully match S3Client's words.
      expect(result[0]).toBe("src/S3Client.ts");
    });

    it("ranks AppLayout.tsx above ALayout.tsx when query is 'app layout'", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/ALayout.tsx\0src/AppLayout.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "app layout",
        limit: 5,
      });

      // Without the word-length guard, "app".startsWith("a") would falsely
      // match ALayout's "a" word, tying it with AppLayout and winning on
      // pathLen. The w.length >= 3 guard suppresses these false positives.
      expect(result[0]).toBe("src/AppLayout.tsx");
    });

    it("keeps exact ties in listing order across the cutoff", async () => {
      // Every file fits fully and every path is one length, so listing order is
      // the only thing left to rank them by. The listing is deliberately not
      // sorted, so neither path nor directory order can stand in for it.
      const listing = Array.from(
        { length: 30 },
        (_, i) => `d${String((i * 7) % 30).padStart(2, "0")}/UserProfile.tsx`
      );
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, `${listing.join("\0")}\0`);

      const service = await createService();
      const page = await service.searchNaturalLanguage({
        cwd: dir,
        description: "user profile",
        limit: 20,
      });

      expect(page).toEqual(listing.slice(0, 20));
    });

    it("builds its word index once per listing, on the first lookup that needs it", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "src/UserProfilePanel.tsx\0src/SettingsDialog.tsx\0");
      const service = await createService();

      // The picker and a description of nothing but stop words never need one.
      await service.search({ cwd: dir, query: "user", limit: 5 });
      await service.searchNaturalLanguage({ cwd: dir, description: "the file" });
      expect(service.peekNaturalLanguageIndex(dir)).toBeUndefined();

      // Two descriptions resolved together, as one dictation's file links are.
      await expect(
        Promise.all([
          service.searchNaturalLanguage({ cwd: dir, description: "user profile" }),
          service.searchNaturalLanguage({ cwd: dir, description: "settings dialog" }),
        ])
      ).resolves.toEqual([["src/UserProfilePanel.tsx"], ["src/SettingsDialog.tsx"]]);
      const index = service.peekNaturalLanguageIndex(dir);
      expect(index).toBeDefined();

      await service.searchNaturalLanguage({ cwd: dir, description: "profile panel" });
      expect(service.peekNaturalLanguageIndex(dir)).toBe(index);
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
    });

    it("drops its word index with the listing, so a changed tree is indexed afresh", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "src/UserProfilePanel.tsx\0");
      const service = await createService();
      await service.searchNaturalLanguage({ cwd: dir, description: "user profile" });
      expect(service.peekNaturalLanguageIndex(dir)).toBeDefined();

      service.invalidateUnder(dir);
      expect(service.peekNaturalLanguageIndex(dir)).toBeUndefined();

      gitClientMock.raw.mockResolvedValue("src/UserProfileView.tsx\0");
      await expect(
        service.searchNaturalLanguage({ cwd: dir, description: "user profile" })
      ).resolves.toEqual(["src/UserProfileView.tsx"]);
    });

    it("scores a token once per file however many of its words match it", async () => {
      // `profile` matches both of the first file's words. Counted per matching
      // word rather than per token, the first file would outscore the second.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "ProfileProfiles.ts\0src/ProfilePanel.ts\0");
      const service = await createService();

      await expect(
        service.searchNaturalLanguage({ cwd: dir, description: "profile profile panel" })
      ).resolves.toEqual(["src/ProfilePanel.ts", "ProfileProfiles.ts"]);
    });

    describe("against the per-description scan it replaced", () => {
      function legacySplit(name: string): string[] {
        return name
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
          .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
          .split(/[\s_\-./]+/)
          .filter(Boolean)
          .map((w) => w.toLowerCase());
      }

      const STOP_WORDS = new Set([
        "component",
        "file",
        "the",
        "a",
        "an",
        "to",
        "for",
        "of",
        "and",
        "or",
        "in",
        "my",
        "this",
      ]);

      function legacyRank(files: readonly string[], description: string, limit: number): string[] {
        const tokens = description
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
          .flatMap((t) => legacySplit(t));
        if (tokens.length === 0) return [];
        const scored: Array<{ file: string; score: number; pathLen: number }> = [];
        for (const file of files) {
          if (file.endsWith("/")) continue;
          const words = legacySplit(file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""));
          let matched = 0;
          for (const token of tokens) {
            if (
              words.some(
                (w) =>
                  w === token ||
                  (token.length >= 3 &&
                    w.length >= 3 &&
                    (w.startsWith(token) || token.startsWith(w)))
              )
            ) {
              matched++;
            }
          }
          if (matched > 0)
            scored.push({ file, score: matched / tokens.length, pathLen: file.length });
        }
        scored.sort((a, b) => b.score - a.score || a.pathLen - b.pathLen);
        return scored.slice(0, limit).map((s) => s.file);
      }

      function seededRng(seed: number): () => number {
        let state = seed >>> 0;
        return () => {
          state = (state * 1664525 + 1013904223) >>> 0;
          return state / 2 ** 32;
        };
      }

      const pick = <T>(rng: () => number, items: readonly T[]): T =>
        items[Math.floor(rng() * items.length)]!;

      // Few words and few directories, so most files tie on score and many on
      // path length too, and listing order decides more than one page boundary.
      const NAME_PARTS = [
        "User",
        "Profile",
        "Panel",
        "HTML",
        "Parser",
        "s3",
        "Client",
        "us",
        "Set",
        // Match the first, the thirty-second (a mask's sign bit) and the
        // thirty-sixth distinct filler token below.
        "Qaa",
        "Qfb",
        "Qjb",
      ];
      // Thirty-six distinct three-letter tokens, so a long description holds
      // more distinct tokens than one 32-bit group of the scorer's masks.
      const FILLERS = Array.from(
        { length: 36 },
        (_, i) =>
          `q${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`
      );
      const JOINERS = ["", "", "_", "-", "."];
      const DIRS = ["src", "lib", "a/b", "pkg", "src/ui"];
      const EXTENSIONS = [".ts", ".tsx", ".test.ts", "", "."];
      const DESCRIPTION_WORDS = [
        "user",
        "profile",
        "panel",
        "html",
        "parser",
        "s3",
        "client",
        "us",
        "set",
        "settings",
        "prof",
        "the",
        "UserProfile",
        "file",
        "x",
      ];

      function randomListing(rng: () => number, count: number): string[] {
        const listing: string[] = [];
        for (let i = 0; i < count; i++) {
          if (rng() < 0.1) {
            listing.push(`${pick(rng, DIRS)}/`);
            continue;
          }
          const parts = 1 + Math.floor(rng() * 3);
          let name = pick(rng, NAME_PARTS);
          for (let p = 1; p < parts; p++) name += pick(rng, JOINERS) + pick(rng, NAME_PARTS);
          listing.push(`${pick(rng, DIRS)}/${name}${pick(rng, EXTENSIONS)}`);
        }
        return listing;
      }

      it("ranks every description exactly as before, at every limit", async () => {
        for (let seed = 1; seed <= 12; seed++) {
          const rng = seededRng(seed);
          const listing = randomListing(rng, 300);
          const dir = makeTempDir();
          tempDirs.push(dir);
          gitRepo(dir, `${listing.join("\0")}\0`);
          const service = await createService();
          const files = await service.listFiles(dir);

          for (let q = 0; q < 15; q++) {
            // One long description per listing: the fillers, then ordinary
            // words whose tokens land past the first group.
            const words = 1 + Math.floor(rng() * 4);
            const description = [
              ...(q === 0 ? FILLERS : []),
              ...Array.from({ length: words }, () => pick(rng, DESCRIPTION_WORDS)),
            ].join(" ");
            for (const limit of [1, 20, 100]) {
              const page = await service.searchNaturalLanguage({ cwd: dir, description, limit });
              expect(page, `seed ${seed} "${description}" limit ${limit}`).toEqual(
                legacyRank(files, description, limit)
              );
            }
          }
        }
      });

      it("splits names into the same words as the regex passes", async () => {
        const { splitCamelCase } = await import("../FileSearchService.js");
        const alphabet = [
          ..."abzABZ09 \t_-./$",
          " ",
          " ",
          "﻿",
          "　",
          "é",
          "É",
          "İ",
          "ß",
          "Σ",
          "😀",
        ];
        const rng = seededRng(7);
        for (let n = 0; n < 20_000; n++) {
          let name = "";
          const length = Math.floor(rng() * 12);
          for (let i = 0; i < length; i++) name += pick(rng, alphabet);
          expect(splitCamelCase(name), JSON.stringify(name)).toEqual(legacySplit(name));
        }
        for (let code = 0; code <= 0xffff; code++) {
          const name = `aB${String.fromCharCode(code)}Cd1e`;
          if (splitCamelCase(name).join(" ") !== legacySplit(name).join(" ")) {
            expect(splitCamelCase(name), `U+${code.toString(16)}`).toEqual(legacySplit(name));
          }
        }
      });
    });
  });

  describe("cache lifecycle", () => {
    it("stays warm across a pause the old ten-second TTL would have lapsed", async () => {
      // The reason for the change: a ten-second clock put the next keystroke
      // after any ordinary pause back on `git ls-files` plus a synchronous
      // index build, on the process that also serves every terminal's IPC.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0src/main.ts\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      advanceClock(11_000);
      const afterPause = await service.search({ cwd: dir, query: "main", limit: 5 });

      expect(afterPause).toContain("src/main.ts");
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
    });

    it("holds the entry right up to the five-minute boundary", async () => {
      // Bounds either side of the actual value: a shorter TTL fails the first
      // assertion, a longer one the second. `Cache.get` expires on
      // `now > expiresAt`, so the boundary itself is still a hit.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      freezeClock();
      await service.search({ cwd: dir, query: "read", limit: 5 });

      advanceClock(300_000);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      advanceClock(1);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("does not let a read extend the entry's life", async () => {
      // Expiry is absolute, not sliding. A sliding window would let a steadily
      // searched worktree with no watcher hold a stale index open forever.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      advanceClock(240_000);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      advanceClock(60_001);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });
  });

  describe("invalidateUnder", () => {
    it("drops an index cached under a subdirectory of the invalidated root", async () => {
      // `files.search` is an ActionService action, so it is an MCP tool whose
      // `cwd` comes from the caller: an agent can cache an entry under a
      // subdirectory, which a root-only drop would leave to outlive every
      // change made to it.
      const dir = makeTempDir();
      tempDirs.push(dir);
      const nested = path.join(dir, "src");
      fs.mkdirSync(nested, { recursive: true });
      gitRepo(dir, "main.ts\0");

      const service = await createService();
      await service.search({ cwd: nested, query: "main", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      service.invalidateUnder(dir);
      await service.search({ cwd: nested, query: "main", limit: 5 });

      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("leaves a sibling whose name merely extends the root", async () => {
      const root = makeTempDir();
      tempDirs.push(root);
      const worktree = path.join(root, "repo");
      const sibling = path.join(root, "repo-other");
      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(sibling, { recursive: true });
      gitRepo(worktree, "main.ts\0");

      const service = await createService();
      await service.search({ cwd: worktree, query: "main", limit: 5 });
      await service.search({ cwd: sibling, query: "main", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);

      service.invalidateUnder(worktree);
      await service.search({ cwd: sibling, query: "main", limit: 5 });

      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("rebuilds lazily — the invalidation itself never touches git", async () => {
      // The watcher fires on every debounced flush; rebuilding eagerly there
      // would move the cold load onto the change instead of removing it.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });

      service.invalidateUnder(dir);
      // Across a macrotask, not synchronously: an eager rebuild would await an
      // fs.stat and the git-client construction before reaching `raw`, so an
      // immediate assertion cannot tell it apart from doing nothing.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      gitRepo(dir, "README.md\0src/NewlyAdded.ts\0");
      const afterChange = await service.search({ cwd: dir, query: "NewlyAdded", limit: 5 });

      expect(afterChange).toContain("src/NewlyAdded.ts");
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("fences a load already in flight when the invalidation lands", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      const first = deferGitListing();

      const service = await createService();
      const inFlight = service.search({ cwd: dir, query: "stale", limit: 5 });
      await first.reached;
      service.invalidateUnder(dir);
      first.release("stale.ts\0");
      await inFlight;

      gitClientMock.raw.mockResolvedValue("fresh.ts\0");
      const afterFence = await service.search({ cwd: dir, query: "", limit: 5 });

      // The fenced load must not have seeded the cache: the next search sees
      // the post-change listing, not the one that was already in flight.
      expect(afterFence).toEqual(["fresh.ts"]);
    });

    it("fences a descendant load in flight when its ancestor is invalidated", async () => {
      // The in-flight scan has to match a cwd beneath the invalidated root, not
      // only the root itself.
      const dir = makeTempDir();
      tempDirs.push(dir);
      const nested = path.join(dir, "src");
      fs.mkdirSync(nested, { recursive: true });
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      const first = deferGitListing();

      const service = await createService();
      const inFlight = service.search({ cwd: nested, query: "stale", limit: 5 });
      await first.reached;
      service.invalidateUnder(dir);
      first.release("stale.ts\0");
      await inFlight;

      gitClientMock.raw.mockResolvedValue("fresh.ts\0");
      const afterFence = await service.search({ cwd: nested, query: "", limit: 5 });

      expect(afterFence).toEqual(["fresh.ts"]);
    });

    it("retains nothing for roots it was told about but never searched", async () => {
      // The watcher reports every worktree it sees change, searched or not, and
      // a long-lived main process sees many come and go.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      const pending = deferGitListing();

      const service = await createService();
      const baseline = service.getRetainedKeyCount();
      const inFlight = service.search({ cwd: dir, query: "", limit: 5 });
      await pending.reached;

      const worktrees = Array.from({ length: 200 }, (_, i) =>
        path.resolve(os.tmpdir(), `daintree-retired-worktree-${i}`)
      );
      const cwds = Array.from({ length: 200 }, (_, i) =>
        path.resolve(os.tmpdir(), `daintree-retired-cwd-${i}`)
      );
      const retired = new Set([...worktrees, ...cwds]);

      // Record every Map or Set the invalidations write a retired path into, so
      // the check below covers structures `getRetainedKeyCount` doesn't know of.
      const holders: Array<Map<unknown, unknown> | Set<unknown>> = [];
      const mapSet = Map.prototype.set;
      const setAdd = Set.prototype.add;
      Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (typeof key === "string" && retired.has(key)) holders.push(this);
        return mapSet.call(this, key, value);
      } as typeof mapSet;
      Set.prototype.add = function (this: Set<unknown>, value: unknown) {
        if (typeof value === "string" && retired.has(value)) holders.push(this);
        return setAdd.call(this, value);
      } as typeof setAdd;
      try {
        for (let i = 0; i < worktrees.length; i++) {
          service.invalidateUnder(worktrees[i]);
          service.invalidate(cwds[i]);
        }
      } finally {
        Map.prototype.set = mapSet;
        Set.prototype.add = setAdd;
      }

      service.invalidateUnder(dir);
      pending.release("stale.ts\0");
      await inFlight;
      service.sweep();

      // A structure the service keeps collects the paths of many calls; a call's
      // own scratch set holds at most its own path and is garbage once it
      // returns, though `holders` keeps it reachable here.
      const heldPerHolder = [...new Set(holders)].map(
        (holder) => [...retired].filter((key) => holder.has(key)).length
      );
      expect(heldPerHolder.filter((held) => held > 1)).toEqual([]);
      expect(service.getRetainedKeyCount()).toBe(baseline);
    });

    it("keeps a newer index when an invalidated load settles after it", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      const first = deferGitListing();

      const service = await createService();
      const stale = service.search({ cwd: dir, query: "", limit: 5 });
      await first.reached;
      service.invalidateUnder(dir);

      gitClientMock.raw.mockResolvedValue("fresh.ts\0");
      await expect(service.search({ cwd: dir, query: "", limit: 5 })).resolves.toEqual([
        "fresh.ts",
      ]);

      first.release("stale.ts\0");
      await stale;

      await expect(service.search({ cwd: dir, query: "", limit: 5 })).resolves.toEqual([
        "fresh.ts",
      ]);
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
      expect(service.getRetainedKeyCount()).toBe(1);
    });

    it("keeps a newer load's index when an invalidated load settles before it", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      const first = deferGitListing();

      const service = await createService();
      const stale = service.search({ cwd: dir, query: "", limit: 5 });
      await first.reached;
      service.invalidateUnder(dir);

      const second = deferGitListing();
      const fresh = service.search({ cwd: dir, query: "", limit: 5 });
      await second.reached;
      first.release("stale.ts\0");
      await stale;
      // Checked here, not only at the end: the newer load would paper over a
      // stale commit by overwriting it when it lands. The one retained key is
      // the newer load's own slot, which the stale one must not have taken.
      expect(service.getCacheStats().size).toBe(0);
      expect(service.getRetainedKeyCount()).toBe(1);
      second.release("fresh.ts\0");
      await expect(fresh).resolves.toEqual(["fresh.ts"]);

      await expect(service.search({ cwd: dir, query: "", limit: 5 })).resolves.toEqual([
        "fresh.ts",
      ]);
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("fences a load still settling when dispose runs", async () => {
      // A load that completes after teardown must not reseed the cache — and
      // rearm the sweep — for a service that has been disposed.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      const first = deferGitListing();

      const service = await createService();
      const inFlight = service.search({ cwd: dir, query: "stale", limit: 5 });
      await first.reached;
      service.dispose();
      first.release("stale.ts\0");
      await inFlight;

      expect(service.getCacheStats().size).toBe(0);
    });
  });

  describe("sweep", () => {
    it("frees an expired index without anyone reading its key", async () => {
      // The defect the sweep exists for: `Cache.get` only drops the key it was
      // asked for, so an index for a worktree nobody revisits stayed resident.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(service.getCacheStats().size).toBe(1);

      advanceClock(300_001);
      service.sweep();

      expect(service.getCacheStats().size).toBe(0);
    });

    it("keeps an index that has not expired", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });

      advanceClock(120_000);
      service.sweep();

      expect(service.getCacheStats().size).toBe(1);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
    });

    describe("sweep timer", () => {
      // Only the interval APIs are faked. The service awaits real fs work on
      // every search, and faking setTimeout/Promise scheduling alongside it
      // strands those awaits — so the clock moves via `advanceClock` and only the
      // sweep's own scheduling is under vitest's control.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      });

      afterEach(() => {
        // Before real timers come back: disposal calls clearInterval, and it has
        // to reach the fake one that armed the interval. The outer afterEach runs
        // after this and would be too late.
        for (const service of services) service.dispose();
        services.length = 0;
        vi.useRealTimers();
      });

      it("frees an expired index on its own, without anyone calling sweep", async () => {
        // The timer is the whole mechanism: every other test here calls `sweep()`
        // by hand, so removing `armFileListSweep()` or its interval would leave
        // them all green while nothing ever ran in the app.
        const dir = makeTempDir();
        tempDirs.push(dir);
        gitRepo(dir, "README.md\0");

        const service = await createService();
        await service.search({ cwd: dir, query: "read", limit: 5 });
        expect(service.getCacheStats().size).toBe(1);

        // 60s is the cadence; the entry is only expired once the clock is past
        // the 5-minute TTL, so both have to move.
        advanceClock(300_001);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(service.getCacheStats().size).toBe(0);
      });

      it("stops sweeping once the cache drains, and starts again when it refills", async () => {
        // A timer that kept firing forever would wake an idle app every minute for
        // an empty map; one that never re-armed would leave the next session's
        // indexes to sit there.
        const dir = makeTempDir();
        tempDirs.push(dir);
        gitRepo(dir, "README.md\0");

        const service = await createService();
        await service.search({ cwd: dir, query: "read", limit: 5 });
        expect(vi.getTimerCount()).toBe(1);

        service.invalidate(dir);
        expect(vi.getTimerCount()).toBe(0);

        await service.search({ cwd: dir, query: "read", limit: 5 });
        expect(vi.getTimerCount()).toBe(1);

        // And exactly one, however many entries it is covering.
        const second = makeTempDir();
        tempDirs.push(second);
        await service.search({ cwd: second, query: "read", limit: 5 });
        expect(vi.getTimerCount()).toBe(1);
      });

      it("stops sweeping when the sweep itself empties the cache", async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);
        gitRepo(dir, "README.md\0");

        const service = await createService();
        await service.search({ cwd: dir, query: "read", limit: 5 });

        advanceClock(300_001);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(vi.getTimerCount()).toBe(0);
      });

      it("dispose stops the sweep", async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);
        gitRepo(dir, "README.md\0");

        const service = await createService();
        await service.search({ cwd: dir, query: "read", limit: 5 });
        service.dispose();

        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("dispose drops every index", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      service.dispose();

      expect(service.getCacheStats().size).toBe(0);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });
  });

  describe("backslash queries", () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    afterEach(() => Object.defineProperty(process, "platform", realPlatform));

    async function searchWith(platform: string, query: string): Promise<string[]> {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/components/Worktree/Card.tsx\0back\\slash.txt\0");
      const service = await createService();
      await service.search({ cwd: dir, query: "", limit: 10 });
      Object.defineProperty(process, "platform", { value: platform });
      try {
        return await service.search({ cwd: dir, query, limit: 10 });
      } finally {
        Object.defineProperty(process, "platform", realPlatform);
      }
    }

    it.each([
      "src\\components\\Worktree",
      ".\\src\\components\\Worktree",
      "src/components/Worktree",
    ])("resolves %s on Windows", async (query) => {
      const result = await searchWith("win32", query);
      expect(result).toContain("src/components/Worktree/Card.tsx");
      expect(result).toEqual(await searchWith("win32", "src/components/Worktree"));
    });

    it("keeps a literal backslash match on POSIX", async () => {
      expect(await searchWith("linux", "back\\slash")).toEqual(["back\\slash.txt"]);
      expect(await searchWith("linux", "src\\components")).toEqual([]);
    });
  });

  describe("git ls-files NUL handling", () => {
    it("preserves filenames containing newlines and tabs via NUL-delimited output", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/weird\nname.ts\0src/with\ttab.ts\0clean.ts\0");

      const service = await createService();
      const result = await service.search({ cwd: dir, query: "", limit: 99 });

      expect(result).toContain("src/weird\nname.ts");
      expect(result).toContain("src/with\ttab.ts");
      expect(result).toContain("clean.ts");
    });
  });
});
