# create-daintree-plugin

Scaffold a new Daintree plugin. This is the `npm create` shim for the `daintree-plugin` CLI: it forwards to `daintree-plugin new` and nothing else.

```bash
npm create daintree-plugin my-plugin
# equivalently
npx create-daintree-plugin my-plugin
```

Both prompt for a publisher, a display name, and a template (`command`, `view`, `mcp`, or `full`), then write `./my-plugin/` with a starter `plugin.json`, a `package.json` whose devDependencies include `@daintreehq/plugin-sdk`, `@daintreehq/plugin-vite` and `daintree-plugin`, a Vite config, and the template's source.

The shim forwards its whole argument list to `daintree-plugin new`, so the same flags work here: `--publisher <id>`, `--template <command|view|mcp|full>`, `--project` (write into the enclosing project's `.daintree/plugins/` instead), and `--yes` to run fully non-interactively from the flags (`--yes` requires `--publisher`, since there is no prompt to fall back on). With `npm create`, put `--` before the flags — npm consumes anything before it as its own options:

```bash
npm create daintree-plugin my-plugin -- --publisher acme --template view --yes
# npx passes the flags through without the `--`
npx create-daintree-plugin my-plugin --publisher acme --template view --yes
```

After scaffolding:

```bash
cd my-plugin
npm install
npx daintree-plugin dev
```

## Documentation

The full plugin documentation — getting started, the development loop, and the manifest reference — lives at [docs/plugins](https://github.com/daintreehq/daintree/tree/develop/docs/plugins).
