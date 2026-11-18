import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeclaredProjectLinks } from "../projectDeclaredLinks.js";

const roots: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeProject(manifest: string | Buffer | null): Promise<string> {
  const root = await makeDir("declared-links-");
  if (manifest !== null) await writeFile(join(root, "package.json"), manifest);
  return root;
}

const MANIFEST = JSON.stringify({
  name: "widget",
  homepage: "https://widget.example.dev",
  repository: { type: "git", url: "git+https://github.com/acme/widget.git" },
  bugs: { url: "https://github.com/acme/widget/issues" },
});

const ALL_THREE = [
  { source: "package.json", title: "Homepage", url: "https://widget.example.dev/" },
  { source: "package.json", title: "Repository", url: "https://github.com/acme/widget" },
  { source: "package.json", title: "Issues", url: "https://github.com/acme/widget/issues" },
];

// Symlinks need privileges on Windows and mkfifo has no equivalent; CI is Ubuntu.
const posixIt = it.skipIf(process.platform === "win32");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("readDeclaredProjectLinks (#17252)", () => {
  it("reads the links the root package.json declares", async () => {
    const root = await makeProject(MANIFEST);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  it("reads a manifest saved with a byte order mark", async () => {
    const root = await makeProject(`${String.fromCharCode(0xfeff)}${MANIFEST}`);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  it("follows edits to the file", async () => {
    const root = await makeProject(JSON.stringify({ homepage: "https://one.example.dev" }));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([
      { source: "package.json", title: "Homepage", url: "https://one.example.dev/" },
    ]);
    await writeFile(join(root, "package.json"), "{ not json");
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
    await writeFile(join(root, "package.json"), MANIFEST);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  it.each([
    ["is missing", null],
    ["is empty", ""],
    ["isn't JSON", "{ name: widget"],
    ["holds an array", JSON.stringify([{ homepage: "https://widget.example.dev" }])],
    ["holds a string", JSON.stringify("https://widget.example.dev")],
    ["declares nothing", JSON.stringify({ name: "widget" })],
  ])("declares nothing when the file %s", async (_label, manifest) => {
    const root = await makeProject(manifest);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  it("declares nothing for a project folder that is gone", async () => {
    const root = await makeProject(MANIFEST);
    await rm(root, { recursive: true, force: true });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  it("skips a manifest too large to be one a person wrote", async () => {
    const padding = " ".repeat(512 * 1024);
    const root = await makeProject(`${MANIFEST.slice(0, -1)},"x":"${padding}"}`);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  it("skips a directory standing where the file should be", async () => {
    const root = await makeProject(null);
    await mkdir(join(root, "package.json"));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  posixIt("refuses a manifest linked from outside the project", async () => {
    const outside = await makeDir("declared-outside-");
    await writeFile(join(outside, "package.json"), MANIFEST);
    const root = await makeProject(null);
    await symlink(join(outside, "package.json"), join(root, "package.json"));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  posixIt("reads through a project folder that is itself a link", async () => {
    const real = await makeProject(MANIFEST);
    const parent = await makeDir("declared-link-parent-");
    const linked = join(parent, "project");
    await symlink(real, linked);
    await expect(readDeclaredProjectLinks(linked)).resolves.toEqual(ALL_THREE);
  });

  posixIt("doesn't wait on a FIFO standing at the path", async () => {
    const root = await makeProject(null);
    execFileSync("mkfifo", [join(root, "package.json")]);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });
});

const PYPROJECT = `[project]
name = "widget"

[project.urls]
Homepage = "https://widget.example.dev"
Documentation = "https://docs.example.dev/widget"
"Bug Tracker" = "https://github.com/acme/widget/issues"
`;

const CARGO = `[package]
name = "widget"
homepage = "https://crates.example.dev/widget"
documentation = "https://docs.rs/widget"
repository = "https://github.com/acme/widget-rs.git"
`;

const CATALOG = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: widget
  links:
    - url: https://grafana.example.dev/d/widget
      title: Dashboard
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: widget-api
  links:
    - url: https://api.example.dev/docs
`;

const PYPROJECT_LINKS = [
  { source: "pyproject.toml", title: "Documentation", url: "https://docs.example.dev/widget" },
];
const CARGO_LINKS = [
  { source: "Cargo.toml", title: "Homepage", url: "https://crates.example.dev/widget" },
  { source: "Cargo.toml", title: "Documentation", url: "https://docs.rs/widget" },
  { source: "Cargo.toml", title: "Repository", url: "https://github.com/acme/widget-rs" },
];
const CATALOG_LINKS = [
  { source: "catalog-info.yaml", title: "Dashboard", url: "https://grafana.example.dev/d/widget" },
  { source: "catalog-info.yaml", title: "api.example.dev", url: "https://api.example.dev/docs" },
];

async function makeManifests(files: Record<string, string>): Promise<string> {
  const root = await makeDir("declared-links-");
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(root, name), text)));
  return root;
}

describe("readDeclaredProjectLinks across manifests (#17254)", () => {
  it("reads each manifest in turn, listing an address once under the first file", async () => {
    const root = await makeManifests({
      "package.json": MANIFEST,
      "pyproject.toml": PYPROJECT,
      "Cargo.toml": CARGO,
      "catalog-info.yaml": CATALOG,
    });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([
      ...ALL_THREE,
      ...PYPROJECT_LINKS,
      ...CARGO_LINKS,
      ...CATALOG_LINKS,
    ]);
  });

  it("reads a project with no package.json", async () => {
    const root = await makeManifests({ "pyproject.toml": PYPROJECT });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([
      { source: "pyproject.toml", title: "Homepage", url: "https://widget.example.dev/" },
      ...PYPROJECT_LINKS,
      {
        source: "pyproject.toml",
        title: "Bug Tracker",
        url: "https://github.com/acme/widget/issues",
      },
    ]);
  });

  it("reads a manifest saved with a byte order mark", async () => {
    const root = await makeManifests({ "Cargo.toml": `${String.fromCharCode(0xfeff)}${CARGO}` });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(CARGO_LINKS);
  });

  const EVERY_MANIFEST = {
    "package.json": MANIFEST,
    "pyproject.toml": PYPROJECT,
    "Cargo.toml": CARGO,
    "catalog-info.yaml": CATALOG,
  };
  const EVERY_LINK = [...ALL_THREE, ...PYPROJECT_LINKS, ...CARGO_LINKS, ...CATALOG_LINKS];

  // Each starts with a link of its own, so a file read up to its error would show it.
  it.each([
    ["pyproject.toml", '[project.urls]\nUnique = "https://unique.example.dev"\n[project.urls\n'],
    [
      "Cargo.toml",
      '[package]\nhomepage = "https://unique.example.dev"\nhomepage = "https://again.example.dev"\n',
    ],
    ["catalog-info.yaml", "metadata:\n  links:\n    - url: https://unique.example.dev\n  x: [\n"],
    // One bad entity spoils the file: a parser can't say where it went wrong.
    ["catalog-info.yaml", `${CATALOG}---\nmetadata: {links: [\n`],
  ])("declares nothing for a malformed %s, while the others still count", async (name, text) => {
    const root = await makeManifests({ ...EVERY_MANIFEST, [name]: text });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(
      EVERY_LINK.filter((link) => link.source !== name)
    );
  });

  it("reads a TOML manifest that holds a 64-bit integer elsewhere", async () => {
    const root = await makeManifests({
      "pyproject.toml": `${PYPROJECT}\n[tool.example]\nbuild_id = 9007199254740993\n`,
      "Cargo.toml": `${CARGO}\n[package.metadata.example]\nbuild_id = 9007199254740993\n`,
    });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([
      { source: "pyproject.toml", title: "Homepage", url: "https://widget.example.dev/" },
      ...PYPROJECT_LINKS,
      {
        source: "pyproject.toml",
        title: "Bug Tracker",
        url: "https://github.com/acme/widget/issues",
      },
      ...CARGO_LINKS,
    ]);
  });

  it("reads a link a catalog names through an alias", async () => {
    const root = await makeManifests({
      "catalog-info.yaml": `x: &runbook {url: https://runbooks.example.dev/widget, title: Runbook}\nmetadata:\n  links:\n    - *runbook\n`,
    });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([
      {
        source: "catalog-info.yaml",
        title: "Runbook",
        url: "https://runbooks.example.dev/widget",
      },
    ]);
  });

  it("declares nothing for a catalog that leans on more aliases than a person writes", async () => {
    const anchors = Array.from({ length: 200 }, (_, i) => `  k${i}: *a`).join("\n");
    const root = await makeManifests({
      "package.json": MANIFEST,
      "catalog-info.yaml": `x: &a {}\nmetadata:\n  links:\n    - url: https://acme.dev\nmore:\n${anchors}\n`,
    });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  it("follows edits to each file", async () => {
    const root = await makeManifests({
      "pyproject.toml": PYPROJECT,
      "Cargo.toml": CARGO,
      "catalog-info.yaml": CATALOG,
    });
    await expect(readDeclaredProjectLinks(root)).resolves.toHaveLength(8);
    await writeFile(
      join(root, "pyproject.toml"),
      PYPROJECT.replace("docs.example.dev/widget", "docs.example.dev/widget/v2")
    );
    await writeFile(join(root, "Cargo.toml"), "[package]\nname = 'widget'\n");
    await writeFile(
      join(root, "catalog-info.yaml"),
      CATALOG.replace("grafana.example.dev/d/widget", "grafana.example.dev/d/widget-v2")
    );
    const links = await readDeclaredProjectLinks(root);
    expect(links.map(({ source, url }) => `${source} ${url}`)).toEqual([
      "pyproject.toml https://widget.example.dev/",
      "pyproject.toml https://docs.example.dev/widget/v2",
      "pyproject.toml https://github.com/acme/widget/issues",
      "catalog-info.yaml https://grafana.example.dev/d/widget-v2",
      "catalog-info.yaml https://api.example.dev/docs",
    ]);
    await rm(join(root, "catalog-info.yaml"));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(links.slice(0, 3));
  });

  it("skips a manifest too large to be one a person wrote", async () => {
    const root = await makeManifests({
      "package.json": MANIFEST,
      "catalog-info.yaml": `${CATALOG}# ${" ".repeat(512 * 1024)}\n`,
    });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  posixIt("refuses a manifest linked from outside the project, keeping the rest", async () => {
    const outside = await makeDir("declared-outside-");
    await writeFile(join(outside, "Cargo.toml"), CARGO);
    const root = await makeManifests({ "package.json": MANIFEST });
    await symlink(join(outside, "Cargo.toml"), join(root, "Cargo.toml"));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });
});
