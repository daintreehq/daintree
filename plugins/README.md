# Plugin catalog and blocklist

Two reviewed lists in this directory are published to the update host, and Daintree fetches them from there:

| File | Published to | What Daintree does with it |
| --- | --- | --- |
| [`catalog.json`](./catalog.json) | `https://updates.daintree.org/plugins/catalog.json` | Lists community plugins in the plugin manager's **Browse** view, installs them from `daintree://plugin/install?id=` links, and checks catalog installs for updates |
| [`blocklist.json`](./blocklist.json) | `https://updates.daintree.org/plugins/blocklist.json` | Refuses to load the plugin versions it names, and unloads running copies |

Each one is changed by a pull request to `develop` and published when the change merges, with no manual upload: `publish-plugin-catalog.yml` and `publish-plugin-blocklist.yml` upload the file and then check that the CDN edge serves it. The catalog was planned for its own repository, `daintreehq/plugins`, which doesn't exist yet, so both lists live here for now. The rest of this directory (`builtin/`, `sample/`, `sample-project/`, `fixtures/`) is plugin source, not covered here. The decision record behind the catalog, with its threat model, is [`docs/plugins/catalog.md`](../docs/plugins/catalog.md).

## The community catalog

Daintree hosts no plugin bytes. Authors publish `.dntr` files on their own GitHub Releases, and each catalog entry pins one reviewed release by its URL and SHA-256:

```json
{
  "id": "acme.widget",
  "repo": "https://github.com/acme/widget-plugin",
  "version": "1.2.0",
  "url": "https://github.com/acme/widget-plugin/releases/download/v1.2.0/acme.widget-1.2.0.dntr",
  "sha256": "<64 lowercase hex digits>",
  "capabilities": ["fs:user-data-read", "mcp:expose"]
}
```

| Field | What it holds |
| --- | --- |
| `id` | The archive's `manifest.name`, a scoped `publisher.name` outside the reserved `daintree.*` namespace |
| `repo` | The GitHub repository the release comes from, `https://github.com/{owner}/{repo}` |
| `version` | The archive's `manifest.version`, as canonical semver with no leading `v` |
| `url` | The release asset, `{repo}/releases/download/{tag}/{asset}.dntr`. Never a `releases/latest/download` URL or a tag named `latest`, since a mutable URL can serve bytes nobody reviewed |
| `sha256` | The SHA-256 of the bytes at `url`, in lowercase |
| `capabilities` | The manifest's `capabilities`, copied in its order (`[]` when it declares none). Daintree shows this list before install; it grants nothing |

[`catalog.schema.json`](./catalog.schema.json) describes the file. The catalog keeps every reviewed release, not just the newest, so `(id, version)` is unique and a new release is a new entry beside the old ones.

### Proposing a listing

1. Cut a GitHub Release in your plugin's repository with the versioned `.dntr` attached. `daintree-plugin package` builds it; [Distribution → Publishing recommendations](../docs/plugins/distribution.md#publishing-recommendations) covers the rest.
2. Take the asset's SHA-256 from the release's `SHA256SUMS`, or from the downloaded file with `shasum -a 256 <file>.dntr`.
3. Add one entry to `entries` in `catalog.json`, copying `id`, `version` and `capabilities` from the archive's `plugin.json`. Leave the entries for earlier releases in place.
4. Open a pull request to `develop`. The `plugin-catalog` CI job downloads the asset and checks it; to run the same check first, use `npx tsx scripts/ci/check-plugin-catalog.ts --base origin/develop`.

### What CI checks

For every entry a pull request adds or changes, the `plugin-catalog` job downloads `url` and fails unless:

- the asset's SHA-256 equals `sha256`;
- the asset is an archive the installer would accept, and its `manifest.name` and `version` equal `id` and `version`;
- `capabilities` equals the manifest's list, in the same order;
- `url` is a versioned `.dntr` release asset in `repo`, never a `latest/download` URL;
- `(id, version)` appears once in the catalog.

The job also parses the whole file with the parser Daintree uses on the published catalog, which refuses the entire catalog if any entry is malformed, and the unit tests hold it to the JSON Schema. The publish workflow downloads every entry again before it uploads.

### What review confirms

Review confirms the source and the bytes: the release is in the listed repository, and the asset is the one whose digest, identity and capabilities the entry lists. It never confirms that the code is safe. A listing isn't a Daintree endorsement, and plugins run unsandboxed with full Node.js privileges, whatever capabilities they declare. The plugin manager says so beside every listing.

A new release from the same repository with the same capabilities can merge once its checks pass. These wait for a person to approve them:

- a first listing of a plugin;
- a capability the plugin's newest earlier listing didn't declare;
- a repository other than the one the newest earlier listing named;
- a change to a release that's already listed.

The `plugin-catalog` job names each of these in its summary. It doesn't block on them, so approving them stays a reviewer's job.

### New releases of a listed plugin

Once a plugin is listed, you don't need to open a pull request for each release. `propose-plugin-catalog-updates.yml` runs every six hours, reads the newest releases of every repository the catalog names, and opens one pull request per new release, built from the downloaded `.dntr`: its SHA-256, and the `id`, `version` and `capabilities` of its manifest. The pull request is labelled `catalog: quick merge` when the repository and capabilities match the plugin's newest entry, or `catalog: needs a person` with the reasons when they don't.

A quick merge is still merged by a person. Merging same-capability releases automatically would let every release after the first reach people unreviewed, which pinning each release exists to prevent; the check proves the bytes match the entry, not that the release is the one its author meant to ship.

The bot proposes a release when:

- its repository is named by an entry for that plugin, so listing one plugin never lets its repository propose another;
- it is a published release, not a draft or a GitHub prerelease, and its manifest version is canonical semver with no prerelease part;
- that version is above the plugin's newest entry, so an older release, or one removed from the catalog below the newest, is never proposed;
- no pull request has proposed it: none of the bot's own in any state, and no open one from anyone. A bot pull request that was closed without merging means a person declined that release, so it isn't proposed again; list it by hand if it should be.

A first listing, a prerelease, or a backport below the newest entry is still the author's pull request. Two releases of the same plugin each get their own pull request against `develop`, so the second conflicts once the first merges; resolve it in place.

### Reporting an entry

Report a listed plugin by opening an issue on [`daintreehq/daintree`](https://github.com/daintreehq/daintree/issues/new) that names its `id` and `version` and says what's wrong: a release that does something its listing doesn't show, a compromised repository, or an entry that no longer matches its release.

### Delisting and the blocklist

Removing an entry stops new installs and new updates of that release through the catalog. An update check of a catalog install offers a newer listed release if there is one, and otherwise says the plugin was delisted. Either way, removing an entry does nothing to copies already installed: they keep running.

The blocklist is what reaches installed copies. A compromised or malicious release is removed from the catalog and also added to `blocklist.json` by name and version range, which makes Daintree refuse to load it and unload running copies when a refreshed list arrives. [Architecture → Signing and kill-switch](../docs/plugins/architecture.md#signing-and-kill-switch) has the entry format and when a new entry takes effect.
