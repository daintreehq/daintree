# Distribution

Plugins can be distributed three ways:

1. **Sideload** — drop a directory into `~/.daintree/plugins/`
2. **File install** — share a `.dntr` package file
3. **URL install** — paste a URL pointing to a `.dntr` file

No marketplace or central registry is involved. Authors host their own plugins on GitHub Releases, their website, or any public URL.

## The `.dntr` package format

A `.dntr` file is a zip archive containing a plugin.

```
my-plugin-0.1.0.dntr       (zip archive)
├── plugin.json
├── dist/
│   └── index.js
│   └── index.js.map
├── skills/
│   └── tdd-workflow.md
└── icons/
    └── logo.svg
```

**Rules:**

- `plugin.json` must be at the archive root.
- Paths referenced in `plugin.json` (`main`, `componentPath`, `path` in skills, `args` in mcpServers) resolve relative to the archive root after extraction.
- Archive is standard zip; authors can produce it with any tool, but `daintree-plugin package` is the recommended builder.

The `.dntr` extension is associated with Daintree at OS level after installation. Double-clicking a `.dntr` file opens Daintree's install dialog.

## Packaging

```bash
daintree-plugin package
```

Produces `{pluginId}-{version}.dntr` in the project root. Runs through:

1. Validates the manifest via the same Zod schema Daintree uses at load.
2. Builds the plugin with Vite (unless `--skip-build` is passed).
3. Copies the build output + referenced assets + manifest into a zip.
4. Excludes `node_modules/`, source files, source maps (unless `--sourcemaps`), and anything in `.gitignore`.

The output is deterministic — the same source tree + `daintree-plugin` version produces a byte-identical `.dntr` file. This matters if you're signing releases or publishing reproducible artifacts.

Use `--verbose` to see what's included. Use `--dry-run` to preview without writing the archive.

## Sideload

The simplest distribution method: put a plugin directory at `~/.daintree/plugins/{publisher}.{name}/`. Daintree scans this directory at startup and loads every plugin that has a valid `plugin.json`.

```bash
mkdir -p ~/.daintree/plugins
cd ~/.daintree/plugins
git clone https://github.com/gpriday/my-plugin.git gpriday.my-plugin
cd gpriday.my-plugin
npm install
npm run build
```

Restart Daintree and the plugin loads.

This is the right distribution method for:

- Your own plugins you're developing for your own use
- Team-internal plugins shared via a private repo
- Anyone who wants to audit or modify a plugin before running it

**Dev plugins:** if you're using `daintree-plugin dev` for hot-reload development, the CLI symlinks your project into `~/.daintree/plugins/` automatically. You don't sideload manually during development.

## File install

A user with a `.dntr` file can install it by:

- **Double-clicking** the file (after first Daintree install, the OS associates the extension)
- **Dragging** the file into Daintree's window
- Running **Preferences → Plugins → Install from file…**

Daintree:

1. Computes a content hash of the archive.
2. Validates the manifest.
3. Shows the install dialog: plugin name, description, declared capabilities, publisher.
4. On user confirmation, extracts into `~/.daintree/plugins/{publisher}.{name}/`.
5. Loads the plugin.

If a plugin with the same `name` is already installed, Daintree compares versions (via semver) and either upgrades, downgrades with explicit confirmation, or blocks with an error if the versions are identical.

## URL install

```
Preferences → Plugins → Install from URL…
```

The user pastes a URL pointing to a `.dntr` file. Daintree:

1. Fetches the URL with a 30 MB size cap and a 10 s timeout.
2. Verifies the content-type is `application/zip` or the URL ends in `.dntr`.
3. Runs the same flow as file install from that point.

**Typical URL patterns:**

- GitHub release asset: `https://github.com/gpriday/my-plugin/releases/latest/download/gpriday.my-plugin.dntr`
- Pinned version: `https://github.com/gpriday/my-plugin/releases/download/v0.2.0/gpriday.my-plugin.dntr`
- Static host: `https://plugins.example.com/linear-planner.dntr`

**Security considerations:**

- Daintree does not validate signatures on URL-installed plugins. Trust is on the user.
- No TLS enforcement beyond what the OS does for HTTPS. Installing from non-HTTPS URLs is allowed but flagged in the dialog.
- Redirects are followed up to 5 hops. Final-URL content-type determines acceptance.
- The install dialog shows the original URL, the resolved URL after redirects, and the declared capabilities, so users can spot suspicious mismatches.

Install only from URLs you trust.

## Updating a plugin

Daintree does not auto-update sideloaded, file-installed, or URL-installed plugins. The user is responsible for re-installing the newer version by the same mechanism.

For plugins distributed via URL, this means:

- Publishers should use stable "latest" URLs where appropriate (GitHub's `releases/latest/download/` works well).
- Users can right-click an installed plugin → "Check for update" — Daintree re-fetches from the original URL and shows a diff if the hash changed.

Auto-updating plugins is a planned feature for a future release, gated behind per-plugin user consent.

## Uninstalling

```
Preferences → Plugins → Installed → {plugin} → Uninstall
```

Daintree:

1. Unloads the plugin (disposer cascade runs).
2. Terminates any MCP subprocesses the plugin had spawned.
3. Deletes `~/.daintree/plugins/{publisher}.{name}/`.
4. Removes plugin-scoped settings from project/user config. **Secrets persist** unless the user explicitly checks "also remove stored secrets" — this is to prevent accidental loss of an API token the user might re-enter for a reinstall.

Uninstall is reversible only from a backup — Daintree doesn't maintain a trash bin for plugins.

## Publishing recommendations

For authors who want to share plugins publicly:

- **GitHub Releases** is the default recommendation. `.dntr` files are small; releases are free; versioning maps cleanly to git tags.
- **README with install instructions.** Include the literal URL to paste into Daintree.
- **Semver your releases.** Daintree uses semver for version comparison and update detection.
- **Set `engines.daintree` honestly.** Lock to the minor version you've tested against (e.g. `^0.8.0`). Don't set `*` — you'll get bug reports from users on Daintree versions you haven't supported.
- **Don't commit `.dntr` files to the source repo.** Build them in CI on release-tag.
- **Pin `@daintreehq/plugin-sdk` tightly.** Pre-1.0, minor versions can break APIs.

## Private distribution

For teams:

- Host `.dntr` files behind your org's auth (VPN-only URL, signed S3 link, internal artifact registry).
- Users install via "Install from URL…" pasting the authenticated URL. Daintree sends cookies with the request for same-origin URLs.
- For internal auto-rollout, use MDM or a shell script that writes directly to `~/.daintree/plugins/`.

Team-internal distribution is fully supported with no cloud dependency on Daintree.
