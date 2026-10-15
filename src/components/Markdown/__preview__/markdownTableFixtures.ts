/**
 * Fixtures for the Markdown tables review harness.
 *
 * Real reference-doc tables rather than lorem: whether a wide table reads well
 * is decided by the cells real docs put in it — inline-code identifiers that
 * cannot break, a description column that can, a yes/no column that needs
 * almost nothing — and filler of one uniform length hides every one of those.
 */

const SMALL_TABLE = `| Command | What it does | Since |
| --- | --- | --- |
| \`init\` | Scaffold a plugin in the current folder | 0.1.0 |
| \`dev\` | Watch the sources and reload into a running Daintree | 0.1.0 |
| \`pack\` | Build a signed \`.dtplugin\` archive, see [publishing](docs/publishing.md) | 0.2.0 |`;

const NETWORK_HOSTS =
  "Hosts the worker may reach. Anything else is refused before the request leaves the sandbox.";

const wideTable = (
  networkHosts: string
) => `| Field | Type | Required | Default | Since | Capability | Example | Description |
| --- | --- | :---: | --- | --- | --- | --- | --- |
| \`id\` | \`string\` | yes | — | 0.1.0 | — | \`acme.release-notes\` | Reverse-DNS identifier. Must be unique across the registry and never change after the first publish. |
| \`engines.daintree\` | \`semver range\` | yes | — | 0.1.0 | — | \`">=0.18.0 <0.20.0"\` | Host versions the plugin was tested against. |
| \`activationEvents\` | \`string[]\` | no | \`["onStartup"]\` | 0.1.0 | — | \`["onCommand:acme.notes.open"]\` | Events that load the worker. Omitting it activates on startup, which every launch pays for. |
| \`contributes.panels[].kind\` | \`"view" \\| "editor"\` | no | \`"view"\` | 0.2.0 | \`ui.panels\` | \`"editor"\` | A read-only view, or an editor that owns a document with a dirty state. |
| \`capabilities.network.allowedHosts\` | \`string[]\` | no | \`[]\` | 0.3.0 | \`network\` | \`["api.github.com", "uploads.github.com"]\` | ${networkHosts} |
| \`contributes.toolbarButtons[].when\` | \`context expression\` | no | \`true\` | 0.4.0 | \`ui.toolbar\` | \`"worktree.isDirty && !agent.running"\` | Shows the button only while the expression holds. |`;

export const README = `# daintree-plugin-cli

Command-line tooling for building, testing and publishing Daintree plugins. Every command reads the manifest in the current folder, so run them from the plugin's root.

## Commands

${SMALL_TABLE}

## Manifest fields

Every field below is read from \`daintree-plugin.json\` when the plugin activates. Unknown fields are ignored with a warning rather than refused, so a typo shows up in the plugin log, not as a failed install.

${wideTable(NETWORK_HOSTS)}

Run \`daintree-plugin validate\` to check a manifest against this table before publishing. The validator uses the same schema the host does, so a manifest that passes here activates there.
`;

/** The same document with one cell of the wide table rewritten, for the rendered diff. */
export const README_EDITED = README.replace(
  NETWORK_HOSTS,
  "Hosts the worker may reach, matched exactly. Anything else is refused before the request leaves the sandbox."
);

/** A plugin view's Markdown block: short, one wide table, no headings above it. */
export const PLUGIN_NOTES = `**Release checklist.** Each row is a step the release workflow runs, in order.

| Step | Command | Runs on | Needs | Timeout | Retries | Artifact |
| --- | --- | --- | --- | --- | --- | --- |
| Build | \`npm run build -- --mode production\` | \`ubuntu-24.04\` | — | 15 min | 0 | \`dist/\` |
| Sign | \`codesign --deep --options runtime --sign "$IDENTITY"\` | \`macos-15\` | Build | 10 min | 2 | \`Daintree.app\` |
| Notarize | \`xcrun notarytool submit --wait --keychain-profile ci\` | \`macos-15\` | Sign | 45 min | 3 | \`Daintree.dmg\` |
`;

/** The checklist with one argument changed deep inside a long command cell. */
export const PLUGIN_NOTES_EDITED = PLUGIN_NOTES.replace(
  "--keychain-profile ci",
  "--keychain-profile release"
);
