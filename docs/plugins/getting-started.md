# Getting Started

Scaffold your first plugin, run it locally with hot reload, and install it in Daintree.

## Prerequisites

- Node.js 22 or newer
- Daintree installed and running
- Basic familiarity with TypeScript

## Create a plugin

```bash
npx create-daintree-plugin my-first-plugin
cd my-first-plugin
```

The scaffolder asks a few questions (plugin name, what contribution points to include, package manager) and generates:

```
my-first-plugin/
├── plugin.json          # manifest
├── package.json         # npm dev deps (not shipped in the plugin package)
├── tsconfig.json
├── vite.config.ts       # pre-configured with @daintreehq/plugin-vite
├── src/
│   └── index.ts         # activate() entry
└── .gitignore
```

A minimal `plugin.json` looks like:

```json
{
  "name": "acme.my-first-plugin",
  "version": "0.1.0",
  "displayName": "My First Plugin",
  "description": "An example Daintree plugin.",
  "main": "dist/index.js",
  "engines": { "daintree": "^0.8.0" },
  "capabilities": [],
  "contributes": {
    "commands": [
      {
        "name": "say-hello",
        "title": "Say Hello",
        "category": "My First Plugin"
      }
    ]
  }
}
```

The `commands[].name` maps to `src/say-hello.ts` by filesystem convention. Its default export becomes the command handler. See [Contribution points → Commands](./contribution-points.md#commands) for full details.

## Write the command

```ts
// src/say-hello.ts
import { showToast } from "@daintreehq/plugin-sdk";

export default async function sayHello() {
  await showToast({ title: "Hello from my plugin" });
}
```

## Run it

```bash
npm run dev
```

This launches `daintree-plugin dev`, which:

- Builds your plugin with Vite in watch mode
- Symlinks it into `~/.daintree/plugins/acme.my-first-plugin` as a dev plugin
- Opens a WebSocket connection to Daintree
- Reloads the plugin in Daintree every time you change a source file

In Daintree, open the command palette and run **My First Plugin: Say Hello**. A toast appears.

Edit `src/say-hello.ts` to change the toast title. Daintree reloads the plugin within about a second. State inside plugins is lost on reload — this is intentional.

## Package for distribution

```bash
npm run package
```

This produces `acme.my-first-plugin-0.1.0.dntr` in the project root — a zip file containing the manifest and compiled bundle, ready to share. See [Distribution](./distribution.md) for how users install it.

## Next steps

- Add more contribution points — see [Contribution points](./contribution-points.md)
- Register an MCP server or Skill so Daintree's agents can use your plugin — see [Agent extensions](./agent-extensions.md)
- Explore the host API — see [Host API](./host-api.md)
- Understand what runs when — see [Architecture](./architecture.md)
