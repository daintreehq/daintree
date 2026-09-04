# Project plugin samples

Project plugins live in a repository's own `<projectRoot>/.daintree/plugins/`, are committed like any other source, and load only while that project is open in Daintree. They are never loaded from this directory — nothing here is copied into a build or sideloaded by E2E, because there is no footing to sideload a project-scoped manifest onto.

What this root buys is the one gate that does apply: `npm run check:plugin-manifests` validates everything here against the **project-origin** manifest schema, the same one the running host uses for a real `.daintree/plugins/` discovery. That schema is stricter and differently shaped than the built-in one `plugins/sample/` is checked against — `"scope": "project"` is required rather than refused, eight contribution types are rejected outright, and the reserved `daintree.*` publisher namespace is closed. A sample that drifts out of that shape fails here rather than in someone's repository.

| Sample | What it is for |
| --- | --- |
| [`acme.tour`](./acme.tour/) | The canonical one. Zero build, hand-written ESM, and one working example of every part of the surface [the agent brief](../../docs/plugins/agent-brief.md) tells an agent to build against. |

Not to be confused with two neighbours that look similar and are not:

- `plugins/sample/` holds **installed** plugins (`file-tree`, `rich-daintree`, `hello-daintree`). They have a Vite build step and a committed `view/*.js` artifact that `check:sample-views` regenerates and byte-diffs. Copying their structure into a project plugin brings a toolchain a project plugin is specifically designed not to need.
- `plugins/fixtures/project-local/` is a discovery, schema, and watcher probe. It registers no action and its view returns a plain object instead of rendering React, so it proves the loader works and nothing about how to build a UI.
