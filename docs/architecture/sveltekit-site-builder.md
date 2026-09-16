# SvelteKit Site Builder

Select an element in a running SvelteKit dev preview, see which source owns it, and change its text or Tailwind classes as a real source edit. This document is the architecture of record: what it is, where each part lives, and — more importantly — the four things that were proven before any of it was built, because each one removed a subsystem the original specification assumed was necessary.

The product surface is specified elsewhere (the functional and implementation specifications). This file covers mechanism.

## What Svelte already gives us

The whole design turns on one fact, verified against Svelte 5.57 / SvelteKit 2.63 / Vite 8.3 before implementation started:

**A Svelte dev build already carries the source location of every element it renders.** `svelte/src/internal/client/dev/elements.js` attaches a non-enumerable property to each generated DOM element:

```js
element.__svelte_meta = {
  parent: dev_stack,
  loc: { file: "src/lib/Card.svelte", line: 5, column: 2 },
};
```

`loc.file` is the path relative to the Vite project root, in POSIX form. The line is 1-indexed, the column 0-indexed. Both survive SSR and hydration in a real SvelteKit page.

`parent` is a linked list of `DevStackEntry` — `{ type, file, line, column, parent, componentTag? }` where `type` is `component`, `each`, `if`, `await`, `key`, `render` or `snippet`. It is the **render ancestry**, and critically, a `component` entry names the call site _in the parent file_. Clicking a heading inside a repeated card yields:

```
<h2>            src/lib/Card.svelte:5
 └ component    src/routes/+page.svelte:8   <Card>
   └ each       src/routes/+page.svelte:7
     └ render   src/routes/+layout.svelte:11
```

That chain is the breadcrumb, the invocation mapping, and the "which branch actually rendered this" answer, all for free.

### Two subsystems this deleted

The implementation specification proposed a **project development companion**: a new npm package added as a dev dependency to the user's own project, wired into their Vite config, injecting `data-daintree-source` attributes at compile time. It also proposed **paired dev-only comment boundaries** (`<!-- daintree:component-start -->`) plus `preserveComments` to recover component invocations.

Neither is built, because `__svelte_meta` supplies both and costs nothing. What went with them:

- No dependency or config change is written into the user's project, so there is no diff to review, no uninstall to get wrong, and no broken config import left behind.
- No transform-ordering problem against other Svelte preprocessors.
- No production-cleanliness risk. Nothing is ever injected into project source, so a production build cannot contain builder markers — this is true by construction rather than by test.
- No risk of corrupting markup in constructs where comment injection is unsafe.

The specification explicitly permits this substitution: "replacing comment boundaries with a proven compiler adapter is acceptable". The proof is the fixture corpus.

### What it does not give us

`__svelte_meta` is attached by the **dev** runtime only. A production build has none, which is correct — the builder is a development tool — but it means the supported-baseline check is load-bearing rather than cosmetic.

It also does not survive an HMR update as an object identity. A Vite update **replaces the DOM nodes**; `__svelte_meta` is correctly re-attached to the new ones, but any node reference the host was holding is dead. Selection is therefore stored as an identity and re-resolved after every document change, never as a node handle. A stale selection goes stale visibly; it is never re-pointed at whatever now occupies the old position.

## Shape

```
┌────────────────────────────────────────────────────────────────────┐
│ DEV PREVIEW (core, unchanged)                                      │
│   node-pty dev server · proxy origin · viewport · console · CDP     │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ GUEST: the user's running site, sandboxed, no preload        │ │
│   │   guest runtime — injected over CDP, reads __svelte_meta,    │ │
│   │   draws the overlay in a shadow root, reports observations   │ │
│   └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────┬────────────────────────────────────┘
                                │ sitePreview IPC (host-validated)
┌───────────────────────────────┴────────────────────────────────────┐
│ MAIN: SitePreviewBridge — binds a preview, installs/removes the    │
│ guest runtime, validates every envelope, resolves source identity  │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────┴────────────────────────────────────┐
│ BUILT-IN PLUGIN  daintree.sveltekit-builder                        │
│   main/      binding lifecycle, host.fs writes, edit journal, undo │
│   shared/    protocol + domain model, Tailwind semantics, project  │
│   renderer/  the Site Inspector panel                              │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────┴────────────────────────────────────┐
│ packages/svelte-source-model — owns the `svelte` dependency        │
│   location → AST element · deterministic, source-preserving edits   │
└────────────────────────────────────────────────────────────────────┘
```

## Why the Svelte compiler lives in a workspace package

`packages/svelte-source-model` exists to own one dependency. Three alternatives were rejected:

- **`svelte` in Daintree's root manifest.** Daintree is not a Svelte application and should not read as one.
- **Resolving the user's own `svelte/compiler` at runtime**, which the specification recommends for version fidelity. Built-in plugins load **in-process** in Electron main, so this would execute project-controlled JavaScript in the trusted process. Built-ins are in-process precisely because their code is app-bundled and trusted. The secondary problem is that "a SvelteKit app therefore has Svelte installed" is false for a fresh checkout, an uninstalled monorepo app, or Yarn PnP.
- **A bare `package.json` under `plugins/builtin/`.** A root `npm install` ignores a manifest outside the `workspaces` array, so CI would never install it and the tests would silently skip. Worse, `scripts/build-main.mjs` would copy that directory's `node_modules` into the app bundle and it would pass the packaging allowlist — shipping a compiler into the packaged app by accident.

The workspace package is the repo's own established mechanism, already used by five packages. Version skew is then handled where it belongs — in the **support verdict**. The project model reads the project's installed `svelte`, `@sveltejs/kit` and `tailwindcss` versions and reports `preview-only` with a specific reason when any falls outside the supported band, rather than parsing with a mismatched compiler and hoping.

The package is `external`-ised in its own bundle and `await import()`ed by the plugin, so the compiler never sits on the eager main-process path.

## The guest boundary

The dev-preview guest has **no preload** — `electron/window/createWindow.ts` deletes it and forces `sandbox`, `contextIsolation` and `nodeIntegration: false`. Script therefore reaches the page over CDP (`Page.addScriptToEvaluateOnNewDocument`) or `executeJavaScript`, both of which run in the page's main world. The main world is required regardless: `__svelte_meta` is an expando on the DOM node, and expandos are per-world.

The page is untrusted. It is an application under development and a same-origin compromise can forge anything it sends. The rule that follows:

**The guest reports observations. The host resolves identity.**

A guest message carries the raw `__svelte_meta` it read, geometry, and a runtime occurrence id. It never carries a file path the host will act on, a source range, or a revision. The host takes the reported location, reads the file itself through the scope-contained plugin filesystem API, parses it, and derives the range. The worst a lying page can do is point the inspector at the wrong element _of its own project_; it cannot address another file, and it cannot authorise a write. Mutation authority comes from a trusted UI action, never from a message.

Every envelope is validated on five fields before its payload is looked at — protocol version, session, document epoch, sequence, and size — so a stale runtime from a previous binding, a replayed message, or an oversized body is dropped without interpretation.

## Four states, separately proven

The single most common way a visual editor lies is collapsing distinct facts into one green tick. These are tracked and reported separately:

| Fact | How it is proven |
| --- | --- |
| Source saved | The write returned, with the new content hash. |
| Preview refreshed | The guest acknowledged a later document revision. |
| Styles generated | Computed style was read back out of the guest. A class reaching the DOM does **not** mean Tailwind emitted a rule for it. |
| Reviewed | The user said so. |

The third is not hypothetical. Adding a never-before-used utility to a project without Tailwind installed writes source correctly, reaches the DOM correctly, and renders nothing — computed padding stays `0px`. With Tailwind wired up, the same edit produces a real rule through the project's own Vite pipeline. Both were reproduced before the inspector was designed, which is why "saved" and "visible" are different words in the UI.

## Writes

Edits go through `host.fs.writeFile(path, contents, { expectedRevision })`, which is already an atomic compare-and-swap: the revision is the sha256 of the file's bytes, a mismatch is refused with `REVISION_MISMATCH` carrying the current revision, and every path is realpath-contained to the plugin's declared `scopes.fs.allowedPaths`. The builder adds a journal on top for Undo, not a second write path.

Edits are planned before they are applied. A plan is a set of replacements over ranges of the _original_ source, applied in one pass, so unrelated bytes — whitespace, comments, quote style, classes the builder does not recognise — survive verbatim. The candidate is re-parsed and the protected ranges are checked before anything reaches disk; a candidate is never written just to discover whether it compiles.

## Scope, honestly

A rendered element, the markup that defines it, and the invocation that produced this particular copy are three different things. One `<article>` in one component draws all three pricing cards: editing it changes all three. The inspector therefore shows the number of rendered occurrences a source range controls **before** it enables a control, and "this element only" is never offered as a writable scope when the source says otherwise.

What the builder can enforce: the operation, the node, the file, the expected revision, and the scope containment on the path. What it cannot: that a shared component change has no effect elsewhere in arbitrary application logic. The copy says the first and never implies the second.

## Related

- `docs/plugins/` — the plugin system this is built on.
- `docs/architecture/dev-preview-event-routing.md` — the preview lifecycle and its notification tiers, which this reuses rather than replaces.
- `docs/feature-curation.md` — the bounded exception that permits source writing at all, and its limits.
