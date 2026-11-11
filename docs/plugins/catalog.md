# Community plugin catalog

How community plugins become discoverable, and the trust policy that comes with it. This is the decision record for [#16342](https://github.com/daintreehq/daintree/issues/16342). Only "Where things stand" and the parts marked **shipped** describe Daintree as it ships today. The catalog itself (its repository, entries, review and moderation) doesn't exist yet, and every step marked **planned** is still to be built.

## Decision

**Go: a reviewed list on GitHub. No registry, and no signing in the first cut.**

- The catalog is a JSON file, `catalog.json`, kept in `daintreehq/plugins` and published beside the [blocklist](./trust-model.md#3-explicit-non-guarantees-the-10-contract). Changes are pull requests.
- Authors host their own `.dntr` files on their own GitHub Releases. Daintree hosts no plugin bytes.
- Every entry pins one reviewed release: its URL and its SHA-256. A release nobody reviewed has no entry, so it can't reach anyone through the catalog.
- A registry (Open VSX, Harbor with ORAS, Verdaccio) waits for a concrete need. A self-hosted one means operating publishing, storage and retention before anything needs them; the public Open VSX instance avoids that but imposes its own package model and publishing terms. None of them understands `.dntr` or Daintree's trust contract.
- Signing waits too. A listed digest shows that the bytes are the ones reviewed, not who published them.

## Where things stand

- **#9305 (curated catalog), closed.** The plugin manager, URL install and `daintree://` deep links shipped. Since #16782 the plugin manager's Browse view lists the community catalog; `PluginCatalog` still renders only installed plugins. #9305 also covered first-party plugins only; community entries need the rules below. Since #16779 a `daintree://plugin/install?id=` link installs from the catalog and records `source: "catalog"` with the entry's id, version and repository.
- **#10524 (trust and signing), via #10551.** Only the consent half shipped. Sigstore was deferred because there was no publish pipeline and nothing signed to verify, and `.dntr` archives still carry no signature ([Trust model → Explicit non-guarantees](./trust-model.md#3-explicit-non-guarantees-the-10-contract)).
- **Integrity.** Every archive install records the archive's SHA-256 (`archiveHash`). A confirmed update is bound to the digest its preview was read from, and so is a URL install confirmed from its preview (#16776). A fresh install can be bound to a reviewed digest too: `daintree-plugin install <url-or-path> --sha256 <hex>` installs only if the archive matches, and only if the plugin isn't installed yet ([Distribution → From the CLI](./distribution.md#from-the-cli)).
- **Updates.** For a URL install, **Check for updates** re-fetches the URL the plugin was installed from and compares digests. Since #16781 a catalog install is checked against a freshly fetched catalog instead: it offers the newest reviewed release above the installed version, says when the plugin or the installed release was delisted, and says when no fresh catalog could be read ([Distribution → Updating a plugin](./distribution.md#updating-a-plugin)).
- **Disclosure.** An archive opened from the operating system, a URL install and a catalog install each show the archive's capabilities before it is installed.
- **Kill-switch.** The blocklist at `updates.daintree.org/plugins/blocklist.json` matches by plugin name and version range, refuses to load a match, and unloads a running copy when a refreshed list arrives. It is the only control that reaches plugins already installed. The list is maintained in this repository as `plugins/blocklist.json` and published on every change merged to `develop` (#16774), not in `daintreehq/plugins`.
- **Catalog client.** The main process can fetch `updates.daintree.org/plugins/catalog.json`, validate it and cache it under `userData` (`PluginCatalogService`), following the rules in [Reading the catalog](#reading-the-catalog). A catalog install link, an update check of a catalog install and the plugin manager's Browse view call it: no fetch happens at startup or when the plugin manager opens.
- **Deep links.** `daintree://plugin/install?id=<publisher.name>[&version=]` resolves the release from a freshly fetched catalog, previews it, and installs only the entry's digest; `?url=<https url>&sha256=<hex>` previews and installs only an archive with that digest ([Distribution → Deep links](./distribution.md#deep-links)).

## Options compared

"Native" is what the option gives without Daintree building anything; the rest is what Daintree would have to build or run.

|  | GitHub list | Open VSX | Harbor + ORAS | Verdaccio |
| --- | --- | --- | --- | --- |
| `.dntr` compatibility | Native: release assets are plain files | None: packages are VS Code `.vsix` with `package.json` extension metadata; `.dntr` would need wrapping and its own manifest mapping | Native as an opaque OCI artifact; Daintree defines the media type and a pull client | None: npm tarballs; `.dntr` would need wrapping in a package |
| Discovery | Build: the list and a Browse view | Native web UI and API, VS Code–shaped | Build: Harbor lists repositories, not plugins | Native npm search and web UI, npm-shaped |
| Publishing | Native: authors cut GitHub Releases; an entry is a pull request | Native `ovsx publish`, with a publisher account and a created namespace (verified namespace ownership is optional) | Native `oras push`, behind registry accounts we would run | Native `npm publish`, behind accounts we would run |
| Integrity | Build: the entry's SHA-256, checked by the installer (the check ships) | Registry-side hashes of `.vsix` files, not of `.dntr` | Native content digests, but of the OCI manifest and blobs; the `.dntr` digest still needs mapping | npm tarball integrity, not of the `.dntr` inside |
| Signing | Deferred; GitHub artifact attestations or Sigstore later | Registry-side signing of `.vsix` when the registry is configured for it, under the registry's keys | Native Cosign or Notation, with keys and policy Daintree would define | None native |
| Moderation | Native: pull-request review, history, revert | Registry admins of the public instance (Eclipse Foundation), or our own instance | Our own registry admins | Our own registry admins |
| Licensing | No new software; entries point at each repository's own license | EPL-2.0 server; the public instance requires a publisher agreement | Apache-2.0 | MIT |
| Operating effort | A JSON file and a review queue | Low on the public instance, but its terms and package model aren't ours; high self-hosted | High: a registry, storage, auth, backups, retention | Medium: a server, storage, auth, backups |

The registries each solve publishing and storage, which GitHub Releases already solve for free, and none of them solves Daintree's part: binding an install to reviewed bytes and showing the capabilities before trust is given. That part has to be built whichever option hosts the files, so the cheapest host wins.

## The catalog

**Planned.** This section is the policy the catalog will follow; neither `daintreehq/plugins` nor its bot exists yet.

### Entry

Each entry is one reviewed release:

```json
{
  "id": "daintreehq.continue-session",
  "repo": "https://github.com/daintreehq/plugin-continue-session",
  "version": "0.1.1",
  "url": "https://github.com/daintreehq/plugin-continue-session/releases/download/v0.1.1/daintreehq.continue-session-0.1.1.dntr",
  "sha256": "<64 hex>",
  "capabilities": ["fs:user-data-read", "mcp:expose"]
}
```

- `id` is the archive's `manifest.name`. `id` and `version` together identify an entry, since the catalog keeps every reviewed release, not just the latest.
- `url` is a versioned asset, never a `latest/download` URL: a mutable URL can serve bytes nobody reviewed.
- `sha256` is the digest of the bytes at `url` when the entry was reviewed.
- `capabilities` is the manifest's list at review time, so a change shows up as a diff in the pull request.

### Reading the catalog

**Shipped** in the app, ahead of the catalog itself.

- The file is `{ "entries": [ ... ] }`. Unknown fields are ignored, and so are capability names the reading build doesn't know: the list is shown, never granted.
- An entry is valid when `id` is a scoped plugin name outside `daintree.*`, `version` is canonical semver, `repo` is `https://github.com/{owner}/{repo}`, `url` is a `.dntr` asset under that repository's `releases/download/{tag}/` (never `releases/latest/download`, never a tag named `latest`), and `sha256` is 64 hex digits.
- One malformed entry or a repeated `(id, version)` rejects the whole file, and the last good copy stays cached. A partly read catalog would make a missing release ambiguous, so "not listed" always means absent from a freshly fetched, fully validated catalog.
- Browsing reuses a copy fetched in the last 15 minutes, and falls back to an older one, marked stale, when it can't refresh. Installing or updating always fetches again, so offline nothing installs from the catalog, and a caller can tell a stale or unavailable catalog from a release that isn't listed.
- A 404 means the catalog isn't published, not an error.

### Review

A bot watching each listed repository opens a pull request per new release. Review confirms:

- the release is in the listed repository, and the asset's SHA-256 matches the entry;
- the archive's `manifest.name` and `version` match the entry;
- the capabilities match the manifest.

A new release from the same repository with the same capabilities merges quickly. A new capability, a changed repository, or a first listing waits for a person.

Review confirms the source and the bytes. It does not confirm that the code is safe, and the listing says so. Plugins run unsandboxed with full Node.js privileges, whatever they declare.

Pinning only the repository is the Obsidian model, where every release after the first reaches users unreviewed. Pinning each release is what makes the digest mean something.

### Moderation and removal

- Anyone will be able to report an entry through an issue on `daintreehq/plugins`.
- Removing an entry stops new installs and new updates. It does not touch installed copies: the plugin keeps running.
- A compromised or malicious release also goes on the blocklist, by name and version range. That refuses it at load and unloads running copies when the refreshed list arrives.

## One plugin's journey

`daintreehq.continue-session` is the end-to-end test. It sits outside the reserved `daintree.*` namespace, so it installs as a package. Its source moved out of this repository (`plugins/sample/continue-session`) into a public one of its own, [`daintreehq/plugin-continue-session`](https://github.com/daintreehq/plugin-continue-session), where its tests run, and it has two releases, `0.1.0` then `0.1.1`, so install and update both run against real GitHub Releases. Step 4's preview ships today for URL installs, and step 5's digest check ships for those and the CLI.

1. **Publish** (shipped). The author tags `v0.1.0`; the repository's release workflow runs `daintree-plugin package` and attaches the versioned `.dntr` and its `SHA256SUMS` to the release ([`v0.1.0`](https://github.com/daintreehq/plugin-continue-session/releases/tag/v0.1.0), [`v0.1.1`](https://github.com/daintreehq/plugin-continue-session/releases/tag/v0.1.1)).
2. **List** (planned). The bot opens a pull request adding the `0.1.0` entry with the asset's digest; a person reviews it as a first listing.
3. **Discover** (shipped). **Browse** in the plugin manager reads the catalog and lists each plugin's newest reviewed release (the one an unversioned install link would pick) with its repository, its capabilities, and that it is a community listing reviewed for source and bytes, not a Daintree endorsement and not checked for safety. An installed plugin is marked as installed, and **Install** previews that exact release through the catalog route.
4. **Inspect and trust** (shipped for URL installs). Install downloads the archive and shows its identity and capabilities, read from the downloaded bytes, with the full-privilege warning. The user decides whether to trust the publisher.
5. **Install** (shipped). The installer refuses anything but the reviewed digest. That check is reached through a `daintree://plugin/install?id=daintreehq.continue-session` link, which resolves `0.1.0` from a fresh catalog and records the install as a community listing from its repository, through `daintree-plugin install <url> --sha256 <hex>`, and through a URL install's preview, whose confirm installs only the digest it showed.
6. **Update** (shipped in the app). `v0.1.1` gets its own entry. An update check for a catalog install reads the catalog instead of re-fetching the install URL, offers `0.1.1` with its preview, and installs only its digest.
7. **Withdraw** (shipped in the app). Delisting stops new installs, and an update check says the plugin was delisted. A compromise also goes on the blocklist, which reaches installed copies.

## Threat model and verification policy

| Threat | What holds it |
| --- | --- |
| The author's repository or release is compromised after review | The entry pins the reviewed digest; different bytes at the same URL are refused before extraction. A new release needs a new entry, and a new capability or repository needs a person. |
| A mutable tag or a `latest` URL | Entries carry versioned asset URLs, and the digest decides either way. |
| Digest mismatch at install or update | Refused, nothing extracted or replaced, and the error says the archive isn't the reviewed one. Never retried unbound. |
| Approved bytes differ from installed bytes | An update confirm already installs only the digest its preview was read from. A URL install's confirm installs only the digest its preview showed. An archive opened from the operating system is previewed and then installed from its path without a digest binding. |
| A malformed or stripped binding | The installer re-validates every binding it is given and refuses a malformed one. The CLI sends a digest over its own method, which requires one, so a Daintree too old to check it refuses the call instead of installing. Ordinary install routes still accept no binding at all. |
| The catalog itself is compromised | It can list any URL with any digest, so the catalog repository's review and HTTPS are trust roots. Signing alone doesn't change that while the catalog is also what names each publisher's key or identity; it would need an identity policy trusted independently of the catalog. |
| A stale catalog | Browsing may show a cached catalog. A new install or update needs a fresh one, since a stale one may still list a release that was pulled. The catalog client enforces this, and a catalog install link and a catalog install's update check each refuse a stale catalog with their own message. |
| Offline | Nothing new installs from the catalog: a catalog install link or update check says the catalog couldn't be reached or refreshed. Installed plugins keep running, the last cached blocklist stays enforced, and a local `.dntr` can still be installed with `--sha256`. |
| A malicious but faithfully reviewed plugin | Not held: no sandbox. Disclosure, just-in-time consent on gated host surfaces, delisting and the blocklist are the controls. |
| Revoked keys | Not applicable while archives are unsigned. |

### When the user approves again

- **New bytes.** An update offered by **Check for updates** installs only after its preview is confirmed, and only the digest that preview read. An ordinary file or CLI install still replaces an installed plugin without that preview; `--sha256` refuses to replace one. A URL install previews first, says what it replaces, and installs only the previewed digest. A catalog update goes through the same preview and installs only the listed digest.
- **New capabilities.** The update preview lists the new version's capabilities. Grants and MCP pins don't carry over to different bytes, so gated surfaces prompt again; a replacing install can offer the old capability grants back, as one fresh approval.
- **A changed repository.** The catalog review catches it before any user sees it; an update to an entry from another repository is shown as a different source in the update preview, naming both repositories.

## Signing, later

Two routes, neither implemented:

- **GPG detached signatures** with fingerprints listed in the catalog. It needs key distribution, rotation and revocation, and a policy for a signature that no longer verifies. Few plugin authors keep GPG keys.
- **Sigstore**, verifying a release's signing identity (its GitHub Actions workflow and repository) against the identity listed in the catalog, with no long-lived keys. It fits authors who already release from CI, and GitHub artifact attestations produce it.

Whichever lands, a valid signature establishes provenance under the policy, never safety. A verification failure refuses the install, the same as a digest mismatch.

## Next steps

In the order they have to land:

1. **A reviewed digest on a fresh install.** Shipped: the installer accepts a fresh-install binding, and the CLI exposes it as `--sha256`.
2. **Disclosure on URL installs.** Shipped: install from URL and the `daintree://plugin/install` link show the archive dialog's capability list for the downloaded archive first, then install exactly the bytes it showed.
3. **Catalog-driven updates.** Shipped: an update check for a catalog install reads the catalog instead of the install URL, and a delisted plugin says so.
4. **Deep links.** Shipped: `daintree://plugin/install` carries a catalog id, or a URL with its `sha256`.
5. **Browse.** Shipped: a Browse view in the plugin manager, which reads the catalog only when opened. A stale copy is listed with a note saying it couldn't be refreshed; with no copy at all the view says why, and installed plugins are unaffected.

Outside the app: create `daintreehq/plugins` with `catalog.json`, its validation and the release-watching bot. Publish the plugin packages' `0.2.0` to npm too: npm still serves `0.1.0`, which can't build a plugin that uses `host.tasks`, `host.notify` or `mcpName`, so `plugin-continue-session` builds against tarballs packed from `v0.50.0`.
