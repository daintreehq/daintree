# Plugin fixtures

On-disk plugin trees used by tests. Unlike `plugins/builtin/`, `plugins/sample/` and `plugins/sample-project/`, nothing here is loaded by the running app, copied by the build, or validated by `check:plugin-manifests` — that scans the other three only.

## `project-local/`

A miniature project root for the project-local plugin feature. `project-local/` stands in for a user's project, so the fixture plugin sits at the real path discovery will scan:

```
project-local/.daintree/plugins/acme.project-hello/
```

The directory name equals the manifest `name` — convention that every tool assumes, not something discovery checks. `dist/` is committed and hand-written — the plugin has no `src/` and no build, because the host never reads either.

Deliberately minimal: it registers no action and its view returns a plain object instead of rendering React, so it proves discovery, schema and watcher behaviour and nothing about building a UI. For a project plugin worth copying, see [`plugins/sample-project/acme.tour/`](../sample-project/acme.tour/).

## `installed/acme.welcome-tour/`

An installed (global) plugin whose only contribution is a two-chapter tour. `dist/tour.js` is hand-written ESM that bare-imports `react` and `@daintreehq/tour/*`, exactly as a raw plugin module does through the host import map, and styles its own additions with `category-*` tokens beside the kit's. The first chapter's narration is a bundled path and the second a remote URL on the declared `audioHosts`; neither audio file exists, so playback exercises the player's fall-back to captions.
