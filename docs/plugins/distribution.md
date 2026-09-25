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
3. Collects the file list. The candidates are every file `.gitignore` does not exclude, **plus** everything under the build-output directories even when they are gitignored — `dist/` always, and the top-level directory of `main` and of every view `componentPath` — because build output is ignored by convention and is exactly what ships. `.dntrignore` (root only, `.gitignore` syntax) then prunes that union, protected directories included, so `dist/docs/**` can be kept out of the archive; it is strictly subtractive and cannot re-include something `.gitignore` dropped. `plugin.json` is always added. Dotfiles never ship.
4. Applies the normative exclusion list on top: `node_modules/`, `.git/`, source files (`*.ts`/`*.tsx`), source maps (unless `--sourcemaps`), root-level dev metadata (`package.json`, lockfiles, `tsconfig*.json`, `*.config.*`, `.dntrignore` itself) and any `*.dntr`. Then it checks that `main`, every view `componentPath` and every skill `path` survived, and fails naming the missing file rather than writing an archive the installer would reject.
5. Writes the zip.

The output is deterministic — the same source tree + `daintree-plugin` version produces a byte-identical `.dntr` file on the same OS. This matters if you're signing releases or publishing reproducible artifacts. The archive writer (entry order, `plugin.json` first, fixed timestamps) and the normative exclusion list in step 4 are shared with Daintree's own packer, so the host produces the identical archive when it packs the same file set; the selection rules in step 3 — `.gitignore`, the protected build directories, `.dntrignore`, the dotfile skip, and dropping `*.dntr` — are CLI-side policy that the host's `readdir`-based collector does not apply.

Use `--verbose` to see what's included. Use `--dry-run` to preview without writing the archive.

## Archive format

This section is normative. Every tool that produces or consumes `.dntr` files (the `daintree-plugin` CLI, Daintree's installer, third-party packagers) must conform to this spec. The CI round-trip fixture in `electron/services/__tests__/PluginArchive.integration.test.ts` is the contract — if it breaks, the format changed and that is a breaking release.

### Wire format

A `.dntr` file is a standard ZIP archive (PKZIP 2.0, no ZIP64 unless the archive exceeds 4 GB — Daintree rejects archives larger than 30 MB at install time per the URL cap). The file extension is `.dntr` but the container is unmodified ZIP; any ZIP tool can inspect or extract it.

| Parameter | Value |
| --- | --- |
| **ZIP specification** | PKZIP 2.0 (APPNOTE 4.5) |
| **Compression method** | DEFLATE (method 8) |
| **Compression level** | 9 (maximum) |
| **ZIP64** | Prohibited for archives ≤ 30 MB. Daintree rejects any archive over 30 MB. |
| **Entry count** | Max 4096 entries (`MAX_DNTR_ENTRIES`). Archives with more are rejected at extract/verify time (zip-bomb-by-count guard). |
| **Encryption** | Not supported. Daintree rejects encrypted entries. |
| **Entry timestamps** | Fixed at `1980-01-01T00:00:00Z` (MS-DOS epoch). No filesystem timestamps leak in. |

### Entry ordering

Entries must be written in lexicographic order by path, with one exception: `plugin.json` is always the first entry regardless of sort order. The installer reads `plugin.json` by scanning the central directory for the first entry — it does not extract the archive to find it.

```
Index 0: plugin.json
Index 1: dist/index.js
Index 2: dist/index.js.map       (only with --sourcemaps)
Index 3: icons/logo.svg
...
```

Lexicographic sort uses byte-level comparison of UTF-8 path strings (`String.localeCompare` is not deterministic across Node versions; use `Array.sort()` on the raw strings).

### Path rules

- Path separators are always forward slash (`/`), regardless of host OS.
- No absolute paths (leading `/` is rejected).
- No drive letters (Windows `C:\` is rejected).
- No `..` segments (path traversal is rejected at verification time).
- No backslash characters anywhere in the path.
- Directory entries (paths ending in `/`) are not emitted. The installer creates directories on extraction from file paths.

### `plugin.json` as first entry

`plugin.json` must be at the archive root (no path prefix). It must be the first entry in the central directory so the installer can locate it by reading the first file header without extracting the full archive.

### Exclusion patterns

The following are never included in a `.dntr` archive:

- `node_modules/` — dependency trees
- `.git/` — repository metadata
- `.gitignore`'d entries — matched at pack time by the CLI packager, except for the build-output directories it preserves (`dist/` and whatever directory `main` or a view `componentPath` points into), which ship even when gitignored; `.dntrignore` prunes after that and is the way to drop a file from inside one of them
- Source files (`*.ts`, `*.tsx`) — the archive ships compiled output
- Source maps (`*.js.map`, `*.mjs.map`) — excluded by default, included only when `--sourcemaps` is passed to the packager
- Root-level dev metadata — `package.json`, lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`), `tsconfig*.json`, and any root `*.config.*` (e.g. `vite.config.ts`, `tsup.config.mjs`). Scoped to the archive root only — a runtime asset like `dist/app.config.json` is kept. `package.json` is excluded because it carries the author's full dependency layout and, in a monorepo/`file:` setup, leaks the author's absolute home path into every distributed copy.

The reference implementation in `PluginArchive.ts` applies the explicit exclusion list (`REQUIRED_EXCLUSIONS`, `SOURCE_EXTS`, `ROOT_DEV_FILE_NAMES`, `ROOT_CONFIG_FILE`) at both pack and verify time. `.gitignore` matching, the preserved build-output directories, and `.dntrignore` are the CLI packager's responsibility (`packages/daintree-plugin/src/commands/package.ts`), in that order; the host's own packer sees none of them.

### SHA-256 archive hash

The installer computes a SHA-256 hash of the full archive bytes at install time before extraction:

```
archiveHash = SHA-256(archive bytes)
```

This hash is persisted in the plugin's provenance record (`LoadedPluginInfo.archiveHash`) and used for:

- **Update detection**: re-fetching the same URL and comparing hashes tells the user whether a new version is available.
- **Deferred signing** (post-1.0): a signature over the hash is a signature over the archive.
- **Audit trail**: the provenance record ties the installed plugin to a specific byte sequence.

The hash covers the raw ZIP bytes as received — same-OS determinism guarantees the hash is stable for a given source tree and tool version. Cross-platform byte identity is not yet guaranteed (the ZIP "made by" header varies per OS); the hash reflects the bytes as produced by the current platform.

This hash establishes **integrity**, not **authenticity**. It proves the bytes match between two fetches of the same artifact; it does not prove who produced them. `.dntr` archives are unsigned and Daintree performs no publisher-identity verification at any install path (sideload, file, or URL) — see the [trust model](./trust-model.md) for the full non-guarantee contract.

### Cross-platform determinism

Same-OS determinism is guaranteed and tested in CI. Cross-platform byte identity (bitwise identical `.dntr` from macOS, Linux, and Windows builds of the same source) is a known limitation. The ZIP "made by" field in local file headers reflects `process.platform` at build time, so macOS-built and Linux-built archives differ even with identical content, compression, and ordering.

For release signing, build the `.dntr` in a canonical Linux environment (CI). For local development, same-OS determinism is sufficient — the hash is stable across repeated builds on the same machine.

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

**Dev plugins:** for active development, `daintree-plugin dev` hot-reloads a plugin on every save instead of repackaging — see [Development loop](./dev-loop.md#daintree-plugin-dev). Manual sideload (the `git clone … && npm install && npm run build` steps above, then restart to pick up changes) is the alternative when you want the production load path or don't have the CLI on hand.

## File install

A user with a `.dntr` file can install it by:

- **Double-clicking** the file (after first Daintree install, the OS associates the extension)
- **Dragging** the file into Daintree's window
- Running **Preferences → Plugins → Install from file…**

Daintree:

1. Computes a SHA-256 hash of the archive.
2. Validates the manifest against the Zod schema. An unmet `engines.daintree` range doesn't fail the install; the plugin loads with a compatibility warning.
3. Extracts into a temp dir and atomically swaps into `~/.daintree/plugins/{publisher}.{name}/`.
4. Loads the plugin.

The file-install path runs without a pre-install confirmation gate enumerating capabilities or publisher. The only interstitial prompts are the plaintext-HTTP warning (URL installs only) and the update-preview confirm when re-fetching an already-installed plugin's URL. Capabilities are surfaced at MCP-tool-call time through the TOFU consent prompt, not at install time — see `docs/plugins/trust-model.md`.

If a plugin with the same `name` is already installed, Daintree replaces it unconditionally: it unloads the old plugin and atomically swaps the new directory into place (`PluginInstaller.ts`). There is no semver comparison between installed and incoming versions, no downgrade confirmation, and no identical-version block — the install always wins. The swap preserves the original `installedAt` and records `updatedAt`. (Version-aware upgrade/downgrade gating is not yet implemented.)

## URL install

```
Preferences → Plugins → Install from URL…
```

The user pastes a URL pointing to a `.dntr` file. Daintree:

1. Fetches the URL with a 30 MB size cap and a 30 s timeout (shared with the manual update-check path).
2. Accepts the response when the content-type is one of `application/zip`, `application/x-zip`, `application/x-dntr`, or `application/octet-stream`, or — when none of those match — when the original URL's path ends in `.dntr`.
3. Runs the same flow as file install from that point.

**Typical URL patterns:**

- GitHub release asset: `https://github.com/gpriday/my-plugin/releases/latest/download/gpriday.my-plugin.dntr`
- Pinned version: `https://github.com/gpriday/my-plugin/releases/download/v0.2.0/gpriday.my-plugin.dntr`
- Static host: `https://plugins.example.com/linear-planner.dntr`

**Security considerations:**

- Daintree does not validate signatures on URL-installed plugins, at any install path. Trust is on the user. The one automated backstop is the [remote kill-switch](./architecture.md#signing-and-kill-switch): a plugin matching a Daintree-hosted blocklist entry by name and version refuses to load. It is reactive — it helps only against a compromise someone has already reported, and it fails open on any fetch or parse error.
- No TLS enforcement beyond what the OS does for HTTPS. Installing from non-HTTPS URLs is allowed but warned (the `pendingHttpUrl` plaintext-HTTP confirm in `usePluginManager.ts`).
- Redirects are followed **manually**, up to 5 hops (`MAX_REDIRECT_HOPS`), and every hop is independently re-validated: each `Location` must stay `https:` (an `https→http` downgrade is rejected) and its host must clear both the literal SSRF guard and a DNS-resolution check (a public URL that 30x-redirects to a private/loopback/link-local address is rejected before the body is fetched). Acceptance is decided from the final response's content-type; the `.dntr`-suffix fallback is checked against the **original** pasted URL's path, since the resolved URL isn't reliable through Electron's fetch.
- Private, loopback, and link-local hosts are rejected before the fetch runs (SSRF guard).
- The plaintext-HTTP warning shows the original URL so the user can spot a non-HTTPS host before committing. Declared capabilities are not enumerated at install time — consent is gathered per-tool-call at runtime (TOFU; see `docs/plugins/trust-model.md`).

Install only from URLs you trust.

## Updating a plugin

Daintree does not auto-update sideloaded, file-installed, or URL-installed plugins. The user is responsible for re-installing the newer version by the same mechanism.

For plugins distributed via URL, this means:

- Publishers should use stable "latest" URLs where appropriate (GitHub's `releases/latest/download/` works well).
- Users can right-click an installed plugin → "Check for update" — Daintree re-fetches from the original URL and shows a diff if the hash changed.

Auto-updating plugins is a planned feature for a future release, gated behind per-plugin user consent.

## Plugins on remote hosts

A window attached to another machine (a remote host) runs that host's plugins: its installed set, versions, settings, secrets, trust and consent. Plugins installed on the machine you're sitting at don't run against a remote project, and the window loads a plugin's views from the host, so this machine doesn't need the plugin installed to use it there. Nothing syncs between machines in the background.

Settings → Hosts → _host_ → Plugins compares the two machines and groups the differences:

| Group | Meaning | Action |
| --- | --- | --- |
| Only on this machine | Installed here, missing on the host. Its panels, actions and MCP tools are absent in the host's windows. | **Install on _host_** |
| Different versions | The host's version runs in its windows. | **Update on _host_** when this machine's copy is newer; never a downgrade |
| Can't run as they are | No build for the host's OS (`platforms`), `"remote": "unsupported"`, blocked by the blocklist on the host, an `engines.daintree` range the host's build misses (a warning: the plugin still loads), or a user-scope secret with no value on the host | The reason, naming the host |
| Only on _host_ | Works in the host's windows | None needed |

**Install on _host_** copies this machine's package of that one plugin to the host and runs the host's normal install path there. Before anything is copied into the host's plugins folder the manifest is read from the package and refused if it has no build for the host's OS or the host's copy of the plugin blocklist names that version; the rest of the manifest is then validated as for any install. A `.dntr` dropped on the Plugin Manager, or picked with Install from file, in a window attached to a host installs on that host the same way.

Plugin settings and secrets are per host and aren't copied. On a Linux host with no desktop session there is no keyring, so secret fields say that secrets can't be saved there; use environment variables or the tool's own login on that host instead.

When a window switches to a host that lacks some of this machine's plugins, one notice says how many, with **Review** to open this comparison. A saved panel whose plugin the host doesn't have shows a placeholder naming the plugin and the host, with **Install on _host_** when this machine has the plugin; if the host removes a plugin while its panel is open, the panel switches to that placeholder and one toast says so. Calls to a plugin the host doesn't have are refused with a `PLUGIN_NOT_ON_HOST` error.

## Uninstalling

```
Preferences → Plugins → Installed → {plugin} → Uninstall
```

Daintree:

1. Unloads the plugin (disposer cascade runs).
2. Terminates any MCP subprocesses the plugin had spawned.
3. Revokes every TOFU consent pin for the plugin (always, regardless of the settings choice) so a reinstall re-prompts rather than inheriting prior approvals.
4. Deletes `~/.daintree/plugins/{publisher}.{name}/`.
5. By default, **keeps** the plugin's user-scope settings file (`~/.daintree/plugin-settings/{publisher}.{name}.json`) so an API token survives a reinstall. The CLI's `--delete-settings` flag (or the UI's "also remove stored settings" checkbox) deletes that file instead.

Secrets are not stored in a separate file — user-scope `type: "secret"` values live in the same user-scope settings file, encrypted at rest through the OS keychain (Electron `safeStorage`: macOS Keychain / Windows DPAPI / Linux libsecret-kwallet) and persisted as a tagged ciphertext envelope. On a host with no keychain backend (typically headless Linux) a secret can't be saved at all, and the settings UI says so. User-scope secrets share the settings file's lifecycle: "keep settings" keeps them too, and `--delete-settings` removes them.

Project-scope settings (`<projectRoot>/.daintree/plugin-settings/{publisher}.{name}.json`) are **never** touched by uninstall — they're tracked per-repo and removing them is the project's concern. Project-scope secrets are not in that file: they live in this machine's per-project local settings (`~/.daintree/plugin-settings/local/{projectId}/`), which uninstall also leaves in place.

Uninstall is reversible only from a backup — Daintree doesn't maintain a trash bin for plugins.

## Publishing recommendations

For authors who want to share plugins publicly:

- **GitHub Releases** is the default recommendation. `.dntr` files are small; releases are free; versioning maps cleanly to git tags.
- **README with install instructions.** Include the literal URL to paste into Daintree.
- **Semver your releases.** Daintree uses `semver` only for the `engines.daintree` host-compatibility gate — not for update detection. "Check for update" re-fetches the original URL and compares the SHA-256 archive hash against the installed one, so a new build is detected by content change regardless of its version string.
- **Set `engines.daintree` honestly** — an open-ended lower bound at the version you tested against (`">=0.34.0"`), never a caret. Under semver's 0.x rule `"^0.34.0"` means `>=0.34.0 <0.35.0`, so a caret flags the plugin as possibly incompatible from the very next Daintree minor. Don't set `*` either — you'll get bug reports from users on versions you never supported. See [Manifest → `engines.daintree`](./manifest.md#enginesdaintree).
- **Don't commit `.dntr` files to the source repo.** Build them in CI on release-tag.
- **Pin `@daintreehq/plugin-sdk` tightly.** Pre-1.0, minor versions can break APIs.

## Private distribution

For teams:

- Host `.dntr` files behind your org's auth (VPN-only URL, signed S3 link, internal artifact registry).
- Users install via "Install from URL…" pasting the authenticated URL. Daintree sends cookies with the request for same-origin URLs.
- For internal auto-rollout, use MDM or a shell script that writes directly to `~/.daintree/plugins/`.

Team-internal distribution is fully supported with no cloud dependency on Daintree.
