import { describe, it, expect } from "vitest";
import { resolveForgeRemote } from "../forgeRemoteSelection.js";

const GITHUB = "https://github.com/acme/widgets.git";
const FORK = "https://github.com/me/widgets.git";
const INTERNAL = "https://git.internal.example/acme/widgets.git";

/** Stands in for a registry that only knows github.com. */
const githubOnly = (url: string) => url.includes("github.com");

describe("resolveForgeRemote", () => {
  it("selects nothing when there are no remotes", () => {
    expect(resolveForgeRemote({ remotes: [], forgeRemote: null })).toEqual({
      remote: null,
      missingConfiguredRemote: null,
    });
  });

  it("ignores remotes with an empty fetch URL", () => {
    const { remote } = resolveForgeRemote({
      remotes: [
        { name: "origin", fetchUrl: "" },
        { name: "upstream", fetchUrl: GITHUB },
      ],
      forgeRemote: null,
    });
    expect(remote?.name).toBe("upstream");
  });

  it("selects nothing when every remote has an empty fetch URL", () => {
    const { remote } = resolveForgeRemote({
      remotes: [{ name: "origin", fetchUrl: "" }],
      forgeRemote: null,
    });
    expect(remote).toBeNull();
  });

  describe("explicit forgeRemote setting", () => {
    it("wins over name preference and provider matching", () => {
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: GITHUB },
          { name: "upstream", fetchUrl: GITHUB },
          { name: "mirror", fetchUrl: INTERNAL },
        ],
        forgeRemote: "mirror",
        isSupportedRemote: githubOnly,
      });
      expect(remote).toEqual({ name: "mirror", fetchUrl: INTERNAL });
    });

    it("selects a non-origin remote — the issue's reported case", () => {
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: FORK },
          { name: "upstream", fetchUrl: GITHUB },
        ],
        forgeRemote: "upstream",
        isSupportedRemote: githubOnly,
      });
      expect(remote?.fetchUrl).toBe(GITHUB);
    });

    it("fails closed when the named remote no longer exists", () => {
      // Must NOT auto-detect: resolveForCwd backs assign/close/merge, so
      // substituting origin here could redirect a write to a fork.
      const result = resolveForgeRemote({
        remotes: [{ name: "origin", fetchUrl: GITHUB }],
        forgeRemote: "renamed-away",
        isSupportedRemote: githubOnly,
      });
      expect(result).toEqual({ remote: null, missingConfiguredRemote: "renamed-away" });
    });

    it("fails closed even when the named remote exists but has no fetch URL", () => {
      const result = resolveForgeRemote({
        remotes: [
          { name: "upstream", fetchUrl: "" },
          { name: "origin", fetchUrl: GITHUB },
        ],
        forgeRemote: "upstream",
      });
      expect(result).toEqual({ remote: null, missingConfiguredRemote: "upstream" });
    });

    it("treats an empty-string setting as unset", () => {
      const { remote, missingConfiguredRemote } = resolveForgeRemote({
        remotes: [
          { name: "fork", fetchUrl: FORK },
          { name: "origin", fetchUrl: GITHUB },
        ],
        forgeRemote: "",
      });
      expect(remote?.name).toBe("origin");
      expect(missingConfiguredRemote).toBeNull();
    });
  });

  describe("auto-detect", () => {
    it("prefers a provider-matching remote over a better-named unmatched one", () => {
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: INTERNAL },
          { name: "backup", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(remote?.name).toBe("backup");
    });

    it("prefers origin over upstream when both match a provider", () => {
      // Origin-first on purpose: PullRequestService and the built-in GitHub
      // context both auto-detect origin, and a resolver that preferred
      // upstream would point the toolbar at a different repo than the
      // worktree PR badges.
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "upstream", fetchUrl: GITHUB },
          { name: "origin", fetchUrl: FORK },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(remote?.name).toBe("origin");
    });

    it("prefers upstream once origin is not a candidate", () => {
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "zed", fetchUrl: GITHUB },
          { name: "upstream", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(remote?.name).toBe("upstream");
    });

    it("skips an unparseable origin for a remote a provider recognises", () => {
      // The reported bug: origin exists but no provider can read it, so the
      // toolbar went dark instead of using the remote that works.
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "origin", fetchUrl: INTERNAL },
          { name: "upstream", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(remote?.name).toBe("upstream");
    });

    it("falls back to git's listing order when no name is preferred", () => {
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "alpha", fetchUrl: GITHUB },
          { name: "beta", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(remote?.name).toBe("alpha");
    });

    it("does not special-case a remote merely named 'github'", () => {
      // gh ranks a `github`-named remote third; Daintree is forge-neutral, so
      // hostname matching decides instead.
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "github", fetchUrl: INTERNAL },
          { name: "zed", fetchUrl: GITHUB },
        ],
        forgeRemote: null,
        isSupportedRemote: githubOnly,
      });
      expect(remote?.name).toBe("zed");
    });
  });

  describe("no provider match", () => {
    it("still returns a remote so the provider chain reports the failure", () => {
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "mirror", fetchUrl: INTERNAL },
          { name: "origin", fetchUrl: INTERNAL },
        ],
        forgeRemote: null,
        isSupportedRemote: () => false,
      });
      expect(remote?.name).toBe("origin");
    });

    it("ranks by name when no predicate is supplied", () => {
      const { remote } = resolveForgeRemote({
        remotes: [
          { name: "upstream", fetchUrl: GITHUB },
          { name: "origin", fetchUrl: FORK },
        ],
        forgeRemote: null,
      });
      expect(remote?.name).toBe("origin");
    });

    it("treats a throwing predicate as no match rather than propagating", () => {
      const { remote } = resolveForgeRemote({
        remotes: [{ name: "origin", fetchUrl: GITHUB }],
        forgeRemote: null,
        isSupportedRemote: () => {
          throw new Error("registry exploded");
        },
      });
      expect(remote?.name).toBe("origin");
    });
  });
});
