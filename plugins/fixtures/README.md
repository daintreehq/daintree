# Plugin fixtures

On-disk plugin trees used by tests. Unlike `plugins/builtin/` and `plugins/sample/`, nothing here is loaded by the running app, copied by the build, or validated by `check:plugin-manifests` — those scan `builtin/` and `sample/` only.

## `project-local/`

A miniature project root for the project-local plugin feature. `project-local/` stands in for a user's project, so the fixture plugin sits at the real path discovery will scan:

```
project-local/.daintree/plugins/acme.project-hello/
```

The directory name equals the manifest `name`, which is what discovery expects. `dist/` is committed and hand-written — the plugin has no `src/` and no build, because the host never reads either.
