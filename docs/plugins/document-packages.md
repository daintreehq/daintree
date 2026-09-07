# Document packages

Use document packages to load an npm-based editor adapter once in a project document, even when several plugins use it or a plugin hot-reloads. This is opt-in: ordinary dependencies remain bundled normally. The sharing unit is a complete browser adapter, including the editor and all code that shares its classes, commands, or registries. It is not a runtime npm installer or a general semver resolver.

## Build and consume an adapter

Publish your editor integration as an ordinary npm package, for example `@acme/markdown-editor`, with an exact lockfile and a browser entry. Each consuming plugin declares the same adapter version and document scope in its Vite config:

```ts
import { defineConfig } from "vite";
import { daintreePlugin } from "@daintreehq/plugin-vite";

export default defineConfig({
  plugins: [
    daintreePlugin({
      documentPackages: {
        "@acme/markdown-editor": {
          entry: "src/editor-adapter.ts",
          version: "1.0.0",
          scope: "document",
        },
      },
    }),
  ],
  build: {
    lib: { entry: "src/panel.tsx", formats: ["es"], fileName: "panel" },
  },
});
```

```ts
// src/editor-adapter.ts — this entire graph is retained together
export { mountEditor } from "@acme/markdown-editor";
```

```ts
// src/panel.tsx — reloadable view code
import loadEditor from "virtual:daintree-document-package/@acme/markdown-editor";

const editorModule = loadEditor();
// Within the view's mount effect:
// const { mountEditor } = await editorModule;
// Check disposeSignal.aborted before mounting after an asynchronous load.
// const editor = mountEditor(container, { markdown, onChange });
// disposeSignal.addEventListener("abort", () => editor.dispose(), { once: true });
```

Declare the virtual module for TypeScript using the adapter's public type. This is a type-only dependency and does not bring the editor into the view bundle:

```ts
declare module "virtual:daintree-document-package/@acme/markdown-editor" {
  const load: () => Promise<typeof import("@acme/markdown-editor")>;
  export default load;
}
```

Do not statically import the editor's runtime into the panel as well. Keep class-keyed extensions, custom nodes, commands, and mount/dispose integration inside the adapter. Pass document text, callbacks, and per-instance options across the boundary. Create one editor instance per panel; sharing the module must not share the panels' documents or undo history.

`plugin-vite` runs a separate browser build with no inherited application config, hashes the complete emitted JavaScript with SHA-256, emits `document-packages/<name>/<hash>.js`, and generates the loader. Only the host's React import-map specifiers may remain external. Code splitting is disabled, CSS or secondary output assets are rejected, and adapter source dependencies are added to the outer build's watch list. Keep plain, root-scoped CSS in the view build; the host runtime supplies Tailwind utilities from rendered DOM, including markup produced by npm packages. Tailwind's automatic `node_modules` source exclusion is therefore not a blocker here.

The adapter must not later fetch files relative to its original plugin authority. That authority is invalidated when the provider unloads. Bundled dynamic imports are folded into the adapter; arbitrary runtime `fetch`, workers, and constructed asset URLs remain the author's responsibility. A library requiring such files needs a separate lifetime design before it can be a document package.

For custom build tooling, `loadDocumentPackage<T>(import.meta.url, descriptor)` is also exported by `@daintreehq/plugin-sdk/react`. The descriptor has `name`, exact `version`, a 64-character lowercase SHA-256 `buildId`, `entryUrl`, and optional `scope`. Generate the hash from the whole self-contained adapter; do not hand-maintain it. The entry must resolve to the requesting view's registered local `plugin://` authority, without credentials, query, or fragment. The host's existing protocol containment and plugin trust checks still apply.

## Selection and lifetime

| Situation | Behavior |
| --- | --- |
| No scope specified, or `scope: "plugin"` | One package module per plugin instance and package name; shared across that plugin's views and reloads |
| `scope: "document"` | Cooperating plugins in one project document share the package name |
| Matching exact version and bundle hash | The first request loads the module; concurrent and later requests receive its exports |
| Same name and scope, different version or hash | Refused before evaluating the conflicting build; persistent warning offers a window reload |
| Import rejects after partial evaluation | Failure remains latched until document replacement; retrying cannot safely undo registrations |
| Provider unloads or hot-reloads | Already loaded exports remain resident; no new authority is retained or made addressable |
| Project window reloads | Package cache, custom elements, and warnings reset; the next request selects a provider again |

The first request wins only among byte-identical, version-identical adapters. There is no highest-version selection, silent compatibility fallback, or live library upgrade. Matching versions with different transitive dependency resolutions produce different hashes and are intentionally refused. Ship the same adapter source and lockfile across consumers. Each plugin archive still contains its adapter asset; deduplication saves module evaluation and runtime identity, not archive download size.

Plugin scope separates module state, not browser-global names. Two private adapters that both define `lexxy-editor` still conflict. Use document scope for a deliberately shared global-registering editor. Two incompatible editor versions cannot coexist under the same custom-element names in this document; they require separate documents.

## Lexxy, Trix, and Markdown

Trix 2.1.19 guards its custom-element definitions; `@37signals/lexxy` 0.9.31 registers ten names unconditionally from a timer, so its import can resolve before the registration error occurs. A skipping shim would leave new integration code paired with old classes, so Daintree observes `customElements.define` without suppressing or replacing the native outcome. Known plugin source frames provide plugin/generation attribution, including deferred callbacks; unknown callers remain unknown. The original constructor and exception are preserved. When the conflict originates in a retained adapter, every known consumer receives the warning, including consumers that load later.

Mounted views get a document-local warning without losing their content. Failed views with a document warning omit the misleading remount retry. Global errors with known plugin sources enter the local error store as plugin errors and carry `plugin-renderer-error`, plugin ID, and generation tags in renderer telemetry. This is diagnostic attribution, not an authenticated security identity; trusted same-document code can spoof stacks or change globals.

An npm adapter around Lexxy should await its element definitions before constructing editors, own the entire Lexxy/Lexical integration graph, and expose a text-oriented API such as `mountEditor({ markdown, onChange })`. Markdown import/export, sanitization, and attachment behavior belong in that adapter; this loader does not implement or validate a Markdown editor. Lexxy's Rails Active Storage integration must be supplied as a bundled dependency and configured for the application's upload flow, or replaced within the adapter's own published build. Do not leave `@rails/activestorage` as an unresolved browser external.

The Trusted Types console warning you will see with Lexxy is separate: Lexxy catches refusal of its `lexxy` policy and falls back. This change does not broaden CSP or add a pass-through policy. Keep sanitization at the content boundary. Lexical used directly has no custom-element registration issue; it only needs sharing when your integration requires common module/class identities.

## Security recommendations

The supported boundary today is trusted plugins with explicitly shared package modules. Plugins run in the host document, and their utility-process workers are unsandboxed. A private package scope, SHA-256 identity, separate bundle, Shadow DOM, and Electron preload context isolation do not isolate one inline plugin from another. The hash is a compatibility identifier, not an authenticated signature or runtime integrity attestation. The host does not fetch npm packages or accept remote entry URLs through this API, but already trusted plugin code retains its existing powers.

For your own npm packages, pin releases and transitive dependencies, publish one reviewed editor adapter, and opt cooperating plugins into document scope. Keep plugin-specific host access, secrets, listeners, and mutable document state out of module initialization. Supply only the per-instance operations the adapter needs when creating an editor. Never store one provider's capability-bearing host object in the shared module.

For an untrusted ecosystem, the next architecture should place each plugin UI in a separate sandboxed document with no host preload bridge, a restrictive CSP, and an explicit message protocol accepting validated, structured-clone data. Main must bind permissions to an authenticated sender/frame and plugin instance rather than a caller-supplied plugin ID. Backend execution also needs an actual sandbox or a brokered runtime that denies ambient Node filesystem/process/network access. Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [sandbox model](https://www.electronjs.org/docs/latest/tutorial/sandbox) describe these distinct layers.

Separate documents necessarily have separate custom-element registries and JavaScript instances. If one trusted editor implementation must serve untrusted plugins, make it a host-owned editor surface with a narrow text/message API, rather than sharing its constructors with those plugins. Packaging can deduplicate the files on disk while execution stays isolated. That is a separate execution model and is not claimed by this implementation.
