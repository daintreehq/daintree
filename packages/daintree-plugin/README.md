# daintree-plugin

The command-line tool for building, validating, packaging, and installing Daintree plugins.

```bash
npm install --save-dev daintree-plugin
# or, without installing
npx daintree-plugin <command>
```

A plugin scaffolded with `daintree-plugin new` already lists this package as a devDependency, so its `npm run validate` and `npm run package` scripts find the CLI in `node_modules`.

## Commands

| Command | What it does |
| --- | --- |
| `new <name>` | Scaffold a plugin project from a template (`command`, `view`, `mcp`, `full`); `--project` writes it into the enclosing project's `.daintree/plugins/` instead, `--yes` runs unattended |
| `validate` | Check `plugin.json` against Daintree's own manifest schema; `--env` also resolves `${settings:…}` tokens |
| `package` | Build with Vite and write a deterministic `<name>-<version>.dntr` archive; `--dry-run` lists what would ship |
| `install <path-or-url>` | Install a `.dntr` into the running Daintree |
| `uninstall <pluginId>` | Remove an installed plugin; user-scope settings are kept unless `--delete-settings` |
| `dev` | Hot-reload loop: link the plugin into the running Daintree and rebuild on every save |
| `doctor <projectRoot>` | Check a project's `.daintree/plugins/` against the working tree and git index (built, ESM, tracked, not gitignored) and report the running host's trust state; `--offline` skips the host query |
| `schema` | Print the JSON Schema for `plugin.json`, generated from the same Zod schema the host loads with |
| `tour voice` | Voice each chapter of a `contributes.tours` entry with Inworld TTS (`--voice`, default `Simon`; key from `INWORLD_API_KEY`), write the audio to `tours/<tourId>/` and the cue and caption timing into `plugin.json`. Narration is read from `tours/<tourId>.narration.json` (`{ "chapters": [{ "id", "narration" }] }`); only chapters whose narration or voice changed are re-voiced |
| `tour align --recordings <dir>` | Time your own recordings (`<chapter-id>.wav`/`mp3`/`m4a`/`ogg`/`flac`/`aac`) instead: each is encoded to Ogg Opus in the plugin (needs `ffmpeg`), transcribed with word timestamps by Inworld, and aligned back to the narration's `[[cue]]` markers |
| `tour preview` | Play and scrub the built tour in a browser without Daintree, with cue markers on the timeline and outlines on every `data-tour-anchor`; warns about stale or missing timing and about cues a scene waits on that the narration never marks. `--headless --out <dir>` captures a frame at each cue and writes `capture.json` with the anchor rectangles (needs `playwright-core`) |
| `skill add [name]` | Copy a bundled Claude Code skill into the plugin's `.claude/skills/` (default `daintree-tour`); files that differ from this version's copy are refused unless `--force` |

## Authoring a tour with Claude Code

Every plugin scaffolded with `new` (except `--project`, since project plugins can't contribute tours) includes `.claude/skills/daintree-tour/`, a Claude Code skill that takes you from nothing to a working tour: it asks whether it's a plugin or panel tour, what to show, which voice, and where the Inworld key or your recordings are, then writes the manifest entry, the narration and the scenes, runs `tour voice` or `tour align`, reviews every `tour preview --headless` frame against the narration and Daintree's own tour, and runs `validate`. Start Claude Code in the plugin directory and ask for a tour, or run `/daintree-tour`. For a plugin created before this, run `npx daintree-plugin skill add`. The skill never writes your Inworld key to a file; it passes it to the one command that needs it through `INWORLD_API_KEY`.

## The usual loop

```bash
npx daintree-plugin new my-plugin --publisher acme
cd my-plugin && npm install
npx daintree-plugin dev          # iterate with hot reload
npx daintree-plugin package      # then ship the .dntr
```

`package` and `install` reuse the host's archive writer, normative exclusion list, and verifier, so a `.dntr` built here is byte-identical to one Daintree packs itself on the same OS when both select the same files. File selection is CLI-side policy: the `.gitignore`, `.dntrignore`, dotfile and `*.dntr` rules are applied by this command, not by the host's own directory walk, so the two archives match only when that selection lands on the same file set.

## Documentation

The full plugin documentation — the development loop, the manifest reference, distribution, and the host API — lives at [docs/plugins](https://github.com/daintreehq/daintree/tree/develop/docs/plugins).
