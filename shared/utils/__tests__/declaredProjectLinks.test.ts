import { describe, expect, it } from "vitest";
import {
  declaredLinksFromBackstageCatalog,
  declaredLinksFromCargoToml,
  declaredLinksFromPackageJson,
  declaredLinksFromPyproject,
  MAX_DECLARED_LINKS_PER_MANIFEST,
  mergeDeclaredLinks,
  repositoryBrowseUrl,
} from "../declaredProjectLinks.js";

describe("declaredLinksFromPackageJson (#17252)", () => {
  it("reads homepage, repository and bugs in that order", () => {
    expect(
      declaredLinksFromPackageJson({
        bugs: "https://github.com/acme/widget/issues",
        repository: "https://github.com/acme/widget",
        homepage: "https://widget.acme.dev",
      })
    ).toEqual([
      { source: "package.json", title: "Homepage", url: "https://widget.acme.dev/" },
      { source: "package.json", title: "Repository", url: "https://github.com/acme/widget" },
      { source: "package.json", title: "Issues", url: "https://github.com/acme/widget/issues" },
    ]);
  });

  it("reads bugs as a string or as an object with a url", () => {
    expect(declaredLinksFromPackageJson({ bugs: "https://acme.dev/bugs" })).toEqual([
      { source: "package.json", title: "Issues", url: "https://acme.dev/bugs" },
    ]);
    expect(
      declaredLinksFromPackageJson({
        bugs: { url: "https://acme.dev/bugs", email: "bugs@acme.dev" },
      })
    ).toEqual([{ source: "package.json", title: "Issues", url: "https://acme.dev/bugs" }]);
  });

  it("skips bugs that name only an email address", () => {
    expect(declaredLinksFromPackageJson({ bugs: { email: "bugs@acme.dev" } })).toEqual([]);
    expect(declaredLinksFromPackageJson({ bugs: "mailto:bugs@acme.dev" })).toEqual([]);
  });

  it("reads repository as a string or as an object, as a browsable address", () => {
    expect(
      declaredLinksFromPackageJson({ repository: "git+https://github.com/acme/widget.git" })
    ).toEqual([
      { source: "package.json", title: "Repository", url: "https://github.com/acme/widget" },
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
      { source: "package.json", title: "Repository", url: "https://github.com/acme/monorepo" },
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
    expect(declaredLinksFromPackageJson({ repository: "git://github.com/acme/w.git" })).toEqual([]);
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
    ).toEqual([
      { source: "package.json", title: "Homepage", url: "https://github.com/acme/widget" },
    ]);
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
    ["git+https://github.com/acme/widget#v1.2.0", "https://github.com/acme/widget"],
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

describe("declaredLinksFromPyproject (#17254)", () => {
  it("reads [project.urls] in the file's order, named by their labels", () => {
    expect(
      declaredLinksFromPyproject({
        project: {
          name: "widget",
          urls: {
            Homepage: "https://widget.acme.dev",
            Documentation: "https://docs.acme.dev/widget",
            "Bug Tracker": "https://github.com/acme/widget/issues",
          },
        },
      })
    ).toEqual([
      { source: "pyproject.toml", title: "Homepage", url: "https://widget.acme.dev/" },
      { source: "pyproject.toml", title: "Documentation", url: "https://docs.acme.dev/widget" },
      {
        source: "pyproject.toml",
        title: "Bug Tracker",
        url: "https://github.com/acme/widget/issues",
      },
    ]);
  });

  it("skips values that aren't http(s) addresses, and labels with nothing to show", () => {
    expect(
      declaredLinksFromPyproject({
        project: {
          urls: {
            Source: "git@github.com:acme/widget.git",
            Chat: "irc://irc.libera.chat/widget",
            Funding: 42,
            Changelog: ["https://acme.dev/changes"],
            "  ": "https://acme.dev/blank",
            Homepage: "https://jo:s3cret@acme.dev",
          },
        },
      })
    ).toEqual([{ source: "pyproject.toml", title: "Homepage", url: "https://acme.dev/" }]);
  });

  it("names a link on one line, within a saved link's name length", () => {
    const long = `Docs ${"x".repeat(200)}`;
    const [link] = declaredLinksFromPyproject({
      project: { urls: { [`Release\nnotes`]: "https://acme.dev/a", [long]: "https://acme.dev/b" } },
    });
    expect(link?.title).toBe("Release notes");
    const title = declaredLinksFromPyproject({
      project: { urls: { [long]: "https://acme.dev/b" } },
    })[0]?.title;
    expect(title?.length).toBe(80);
    expect(title?.endsWith("…")).toBe(true);
    expect(long.startsWith(title!.slice(0, -1))).toBe(true);
  });

  it("lists an address two labels share once, under the first", () => {
    expect(
      declaredLinksFromPyproject({
        project: {
          urls: { Homepage: "https://acme.dev", Website: "https://acme.dev/" },
        },
      })
    ).toEqual([{ source: "pyproject.toml", title: "Homepage", url: "https://acme.dev/" }]);
  });

  it.each([
    null,
    "[project.urls]",
    { project: "widget" },
    { project: { urls: ["https://acme.dev"] } },
    { tool: { poetry: { homepage: "https://acme.dev" } } },
  ])("reads nothing without a [project.urls] table (%j)", (manifest) => {
    expect(declaredLinksFromPyproject(manifest)).toEqual([]);
  });
});

describe("declaredLinksFromCargoToml (#17254)", () => {
  it("reads homepage, documentation and repository in that order, the repository browsable", () => {
    expect(
      declaredLinksFromCargoToml({
        package: {
          name: "widget",
          repository: "https://github.com/acme/widget.git",
          documentation: "https://docs.rs/widget",
          homepage: "https://widget.acme.dev",
        },
      })
    ).toEqual([
      { source: "Cargo.toml", title: "Homepage", url: "https://widget.acme.dev/" },
      { source: "Cargo.toml", title: "Documentation", url: "https://docs.rs/widget" },
      { source: "Cargo.toml", title: "Repository", url: "https://github.com/acme/widget" },
    ]);
  });

  it("takes a field the package inherits from the workspace", () => {
    expect(
      declaredLinksFromCargoToml({
        package: {
          homepage: { workspace: true },
          repository: "https://github.com/acme/widget",
        },
        workspace: {
          package: {
            homepage: "https://acme.dev",
            repository: "https://github.com/acme/monorepo",
            documentation: "https://docs.acme.dev",
          },
        },
      })
    ).toEqual([
      { source: "Cargo.toml", title: "Homepage", url: "https://acme.dev/" },
      { source: "Cargo.toml", title: "Repository", url: "https://github.com/acme/widget" },
    ]);
  });

  it("reads a virtual workspace's shared fields, since its root has no package", () => {
    expect(
      declaredLinksFromCargoToml({
        workspace: {
          members: ["crates/*"],
          package: { repository: "https://github.com/acme/monorepo" },
        },
      })
    ).toEqual([
      { source: "Cargo.toml", title: "Repository", url: "https://github.com/acme/monorepo" },
    ]);
  });

  it("ignores values that aren't http(s) addresses or strings", () => {
    expect(
      declaredLinksFromCargoToml({
        package: {
          homepage: { workspace: false },
          documentation: 7,
          repository: "ssh://git@github.com/acme/widget.git",
        },
        workspace: { package: { homepage: "https://acme.dev" } },
      })
    ).toEqual([]);
  });

  it.each([null, [], "Cargo.toml", { package: "widget" }, { dependencies: { serde: "1" } }])(
    "reads nothing from a manifest with no addresses (%j)",
    (manifest) => {
      expect(declaredLinksFromCargoToml(manifest)).toEqual([]);
    }
  );
});

describe("declaredLinksFromBackstageCatalog (#17254)", () => {
  it("reads metadata.links across every entity in the file, in order", () => {
    expect(
      declaredLinksFromBackstageCatalog([
        {
          kind: "Component",
          metadata: {
            name: "widget",
            links: [
              { url: "https://grafana.acme.dev/d/widget", title: "Dashboard", icon: "dashboard" },
              { url: "https://runbooks.acme.dev/widget", title: "Runbook" },
            ],
          },
        },
        {
          kind: "API",
          metadata: { name: "widget-api", links: [{ url: "https://api.acme.dev/docs" }] },
        },
      ])
    ).toEqual([
      {
        source: "catalog-info.yaml",
        title: "Dashboard",
        url: "https://grafana.acme.dev/d/widget",
      },
      { source: "catalog-info.yaml", title: "Runbook", url: "https://runbooks.acme.dev/widget" },
      { source: "catalog-info.yaml", title: "api.acme.dev", url: "https://api.acme.dev/docs" },
    ]);
  });

  it("skips entries without an http(s) url, and documents without links", () => {
    expect(
      declaredLinksFromBackstageCatalog([
        null,
        "widget",
        { metadata: { links: "https://acme.dev" } },
        {
          metadata: {
            links: [
              { title: "No address" },
              { url: "mailto:team@acme.dev", title: "Mail" },
              { url: 42 },
              "https://acme.dev/bare",
              { url: "https://acme.dev/ok", title: 7 },
            ],
          },
        },
      ])
    ).toEqual([{ source: "catalog-info.yaml", title: "acme.dev", url: "https://acme.dev/ok" }]);
  });

  it("reads nothing from an empty file", () => {
    expect(declaredLinksFromBackstageCatalog([])).toEqual([]);
    expect(declaredLinksFromBackstageCatalog([undefined])).toEqual([]);
  });
});

describe("mergeDeclaredLinks (#17254)", () => {
  const link = (source: "package.json" | "pyproject.toml", url: string, title = "Link") => ({
    source,
    title,
    url,
  });

  it("keeps an address under the first manifest that lists it", () => {
    expect(
      mergeDeclaredLinks([
        [link("package.json", "https://acme.dev/", "Homepage")],
        [
          link("pyproject.toml", "https://acme.dev/", "Website"),
          link("pyproject.toml", "https://docs.acme.dev/", "Docs"),
        ],
      ])
    ).toEqual([
      link("package.json", "https://acme.dev/", "Homepage"),
      link("pyproject.toml", "https://docs.acme.dev/", "Docs"),
    ]);
  });

  it("caps each manifest's own links, counting only those no earlier manifest listed", () => {
    const many = Array.from({ length: MAX_DECLARED_LINKS_PER_MANIFEST + 5 }, (_, i) =>
      link("pyproject.toml", `https://acme.dev/${i}`)
    );
    const merged = mergeDeclaredLinks([[link("package.json", "https://acme.dev/0")], many]);
    expect(merged.filter((l) => l.source === "pyproject.toml")).toEqual(
      many.slice(1, MAX_DECLARED_LINKS_PER_MANIFEST + 1)
    );
  });
});
