import { describe, expect, it } from "vitest";
import { declaredLinksFromPackageJson, repositoryBrowseUrl } from "../declaredProjectLinks.js";

describe("declaredLinksFromPackageJson (#17252)", () => {
  it("reads homepage, repository and bugs in that order", () => {
    expect(
      declaredLinksFromPackageJson({
        bugs: "https://github.com/acme/widget/issues",
        repository: "https://github.com/acme/widget",
        homepage: "https://widget.acme.dev",
      })
    ).toEqual([
      { field: "homepage", title: "Homepage", url: "https://widget.acme.dev/" },
      { field: "repository", title: "Repository", url: "https://github.com/acme/widget" },
      { field: "bugs", title: "Issues", url: "https://github.com/acme/widget/issues" },
    ]);
  });

  it("reads bugs as a string or as an object with a url", () => {
    expect(declaredLinksFromPackageJson({ bugs: "https://acme.dev/bugs" })).toEqual([
      { field: "bugs", title: "Issues", url: "https://acme.dev/bugs" },
    ]);
    expect(
      declaredLinksFromPackageJson({
        bugs: { url: "https://acme.dev/bugs", email: "bugs@acme.dev" },
      })
    ).toEqual([{ field: "bugs", title: "Issues", url: "https://acme.dev/bugs" }]);
  });

  it("skips bugs that name only an email address", () => {
    expect(declaredLinksFromPackageJson({ bugs: { email: "bugs@acme.dev" } })).toEqual([]);
    expect(declaredLinksFromPackageJson({ bugs: "mailto:bugs@acme.dev" })).toEqual([]);
  });

  it("reads repository as a string or as an object, as a browsable address", () => {
    expect(
      declaredLinksFromPackageJson({ repository: "git+https://github.com/acme/widget.git" })
    ).toEqual([
      { field: "repository", title: "Repository", url: "https://github.com/acme/widget" },
    ]);
    expect(
      declaredLinksFromPackageJson({
        repository: {
          type: "git",
          url: "git+https://github.com/acme/monorepo.git",
          directory: "packages/widget",
        },
      })
    ).toEqual([
      { field: "repository", title: "Repository", url: "https://github.com/acme/monorepo" },
    ]);
  });

  it("ignores values that aren't http(s)", () => {
    expect(
      declaredLinksFromPackageJson({
        homepage: ".",
        repository: "git@github.com:acme/widget.git",
        bugs: { url: "ftp://acme.dev/bugs" },
      })
    ).toEqual([]);
    expect(declaredLinksFromPackageJson({ repository: "acme/widget" })).toEqual([]);
    expect(declaredLinksFromPackageJson({ repository: "github:acme/widget" })).toEqual([]);
    expect(declaredLinksFromPackageJson({ repository: "git://github.com/acme/w.git" })).toEqual(
      []
    );
    expect(declaredLinksFromPackageJson({ homepage: "javascript:alert(1)" })).toEqual([]);
  });

  it("reads homepage only as a string", () => {
    expect(declaredLinksFromPackageJson({ homepage: { url: "https://acme.dev" } })).toEqual([]);
  });

  it("ignores fields of the wrong type", () => {
    expect(
      declaredLinksFromPackageJson({
        homepage: 42,
        repository: ["https://github.com/acme/widget"],
        bugs: { url: 7 },
      })
    ).toEqual([]);
  });

  it("lists an address two fields share once, under the first", () => {
    expect(
      declaredLinksFromPackageJson({
        homepage: "https://github.com/acme/widget",
        repository: "git+https://github.com/acme/widget.git",
      })
    ).toEqual([{ field: "homepage", title: "Homepage", url: "https://github.com/acme/widget" }]);
  });

  it.each([null, undefined, "{}", 42, [], [{ homepage: "https://acme.dev" }]])(
    "reads nothing from a manifest that isn't an object (%j)",
    (manifest) => {
      expect(declaredLinksFromPackageJson(manifest)).toEqual([]);
    }
  );

  it("reads nothing from an object with none of the fields", () => {
    expect(declaredLinksFromPackageJson({ name: "widget", version: "1.0.0" })).toEqual([]);
  });
});

describe("repositoryBrowseUrl (#17252)", () => {
  it.each([
    ["https://github.com/acme/widget", "https://github.com/acme/widget"],
    ["https://github.com/acme/widget.git", "https://github.com/acme/widget"],
    ["https://github.com/acme/widget.git/", "https://github.com/acme/widget"],
    ["git+https://github.com/acme/widget.git", "https://github.com/acme/widget"],
    ["GIT+HTTPS://GitHub.com/acme/widget.GIT", "https://github.com/acme/widget"],
    ["git+http://git.internal/acme/widget.git", "http://git.internal/acme/widget"],
    ["https://github.com/acme/widget.git#main", "https://github.com/acme/widget"],
    ["https://github.com/acme/widget#readme", "https://github.com/acme/widget#readme"],
    ["  https://gitlab.com/acme/widget  ", "https://gitlab.com/acme/widget"],
  ])("browses %s at %s", (input, expected) => {
    expect(repositoryBrowseUrl(input)).toBe(expected);
  });

  it("drops a username or password a clone address carries", () => {
    expect(repositoryBrowseUrl("git+https://jo@bitbucket.org/acme/widget.git")).toBe(
      "https://bitbucket.org/acme/widget"
    );
    expect(repositoryBrowseUrl("https://jo:s3cret@git.acme.dev/acme/widget.git")).toBe(
      "https://git.acme.dev/acme/widget"
    );
  });

  it.each([
    "",
    "git@github.com:acme/widget.git",
    "ssh://git@github.com/acme/widget.git",
    "git+ssh://git@github.com/acme/widget.git",
    "git://github.com/acme/widget.git",
    "file:///srv/repos/widget.git",
    "acme/widget",
    "github:acme/widget",
    "not a url",
    `https://github.com/${"a".repeat(2100)}`,
  ])("ignores %s", (input) => {
    expect(repositoryBrowseUrl(input)).toBeNull();
  });
});
