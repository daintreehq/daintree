# Project plugin samples

Project plugins live in a repository's own `<projectRoot>/.daintree/plugins/`, are committed like any other source, and load only while that project is open in Daintree. They are never loaded from this directory — nothing here is copied into a build or sideloaded by E2E, because there is no footing to sideload a project-scoped manifest onto.

What this root buys is the one gate that does apply: `npm run check:plugin-manifests` validates everything here against the **project-origin** manifest schema, the same one the running host uses for a real `.daintree/plugins/` discovery. That schema is stricter and differently shaped than the built-in one `plugins/sample/` is checked against — `"scope": "project"` is required rather than refused, eight contribution types are rejected outright, `contributes.surfaces` is accepted _only_ here, and the reserved `daintree.*` publisher namespace is closed. A sample that drifts out of that shape fails here rather than in someone's repository.

| Sample | What it is for |
| --- | --- |
| [`acme.tour`](./acme.tour/) | The canonical one. Zero build, hand-written ESM, and one working example of each thing [the agent brief](../../docs/plugins/agent-brief.md) tells an agent to build: an argument-taking channel, a targeted push, `panel.openPluginPanel` on itself, `file.openPanel`, a `daintree-file://` media fetch, `persistState`, and a panel badge. It does not cover the typed (schema) `registerHandler` overload or broadcast pushes. |

Not to be confused with two neighbours that look similar and are not:

- `plugins/sample/` holds **installed** plugins. `file-tree` and `rich-daintree` each have a Vite build step and a committed `view/*.js` artifact (`check:sample-views` regenerates and byte-diffs `file-tree`'s); `hello-daintree` contributes no view at all. Copying their structure into a project plugin brings a toolchain a project plugin is specifically designed not to need.
- `plugins/fixtures/project-local/` is a discovery, schema, and watcher probe. It registers no action and its view returns a plain object instead of rendering React, so it proves the loader works and nothing about how to build a UI.
