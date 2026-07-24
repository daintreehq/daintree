import { describe, it, expect } from "vitest";
import { resolveForgeRemote } from "../forgeRemoteSelection.js";

const GITHUB = "https://github.com/acme/widgets.git";
const FORK = "https://github.com/me/widgets.git";
const INTERNAL = "https://git.internal.example/acme/widgets.git";

/** Stands in for a registry that only knows github.com. */
const githubOnly = (url: string) => url.includes("github.com");

describe("resolveForgeRemote", () => {
  it("returns null when there are no remotes", () => {
    expect(resolveForgeRemote({ remotes: [], forgeRemote: null })).toBeNull();
  });

  it("ignores remotes with an empty fetch URL", () => {
    const result = resolveForgeRemote({
      remotes: [
        { name: "origin", fetchUrl: "" },
        { name: "upstream", fetchUrl: GITHUB },
      ],
      forgeRemote: null,
    });
    expect(result?.name).toBe("upstream");
  });

  it("returns null when every remote has an empty fetch URL", () => {
    const result = resolveForgeRemote({
      remotes: [{ name: "origin", fetchUrl: "" }],
      forgeRemote: null,
    });
    expect(result).toBeNull();
  });

  describe("explicit forgeRemote setting", () => {
    it("wins over name preference and provider matching", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: GITHUB },
          { name: "upstream", fetchUrl: GITHUB },
          { name: "mirror", fetchUrl: INTERNAL },
        ],
        forgeRemote: "mirror",
        isSupportedRemote: githubOnly,
      });
      expect(result).toEqual({ name: "mirror", fetchUrl: INTERNAL });
    });

    it("selects a non-origin remote — the issue's reported case", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: FORK },
          { name: "upstream", fetchUrl: GITHUB },
        ],
        forgeRemote: "upstream",
        isSupportedRemote: githubOnly,
      });
      expect(result?.fetchUrl).toBe(GITHUB);
    });

    it("falls through to auto-detect when the named remote no longer exists", () => {
      // A renamed or deleted remote must not silently disable forge
      // affordances — that is the failure this resolver exists to prevent.
      const result = resolveForgeRemote({
        remotes: [{ name: "origin", fetchUrl: GITHUB }],
        forgeRemote: "deleted-remote",
        isSupportedRemote: githubOnly,
      });
      expect(result?.name).toBe("origin");
    });

    it("treats an empty-string setting as unset", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: GITHUB },
          { name: "upstream", fetchUrl: GITHUB },
        ],
        forgeRemote: "",
      });
      expect(result?.name).toBe("upstream");
    });
  });

  describe("auto-detect", () => {
    it("prefers a provider-matching remote over a better-named unmatched one", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: INTERNAL },
          { name: "backup", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(result?.name).toBe("backup");
    });

    it("prefers upstream over origin when both match a provider", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: FORK },
          { name: "upstream", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(result?.name).toBe("upstream");
    });

    it("prefers origin over an arbitrarily-named remote", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "fork", fetchUrl: FORK },
          { name: "origin", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(result?.name).toBe("origin");
    });

    it("falls back to git's listing order when no name is preferred", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "alpha", fetchUrl: GITHUB },
          { name: "beta", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(result?.name).toBe("alpha");
    });

    it("does not special-case a remote merely named 'github'", () => {
      // gh ranks a `github`-named remote third; Daintree is forge-neutral, so
      // hostname matching decides instead.
      const result = resolveForgeRemote({
        remotes: [
          { name: "github", fetchUrl: INTERNAL },
          { name: "origin", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(result?.name).toBe("origin");
    });
  });

  describe("no provider match", () => {
    it("still returns a remote so the provider chain reports the failure", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "mirror", fetchUrl: INTERNAL },
          { name: "origin", fetchUrl: INTERNAL },
        ],
        forgeRemote: null,
        isSupportedRemote: () => false,
      });
      expect(result?.name).toBe("origin");
    });

    it("ranks by name when no predicate is supplied", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: FORK },
          { name: "upstream", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
      });
      expect(result?.name).toBe("upstream");
    });

    it("treats a throwing predicate as no match rather than propagating", () => {
      const result = resolveForgeRemote({
        remotes: [{ name: "origin", fetchUrl: GITHUB }],
        forgeRemote: null,
        isSupportedRemote: () => {
          throw new Error("registry exploded");
        },
      });
      expect(result?.name).toBe("origin");
    });
  });
});
