# Svelte mapping fixture corpus

The regression corpus for source mapping and deterministic mutation. Every fixture parses and compiles under `dev: true` with the pinned Svelte 5 compiler; a change that breaks any of them is a change to the mapping contract, not a test to relax.

Each file exists to pin one class of behaviour. Unsupported cases are as important as supported ones: they must degrade to an explained, disabled control rather than an edit that silently targets the wrong node.

| Fixture | Pins |
| --- | --- |
| `native.svelte` | Literal elements, literal text, a literal attribute, an `alt`, SVG (a different namespace, same mapping), and a text node that is an expression rather than a literal. |
| `dynamic-classes.svelte` | The six class forms: array, ternary, literal-with-interpolation, lookup, and a literal `class` on both sides of a `{...spread}`. Only the literal forms are directly editable; the rest must refuse. Also carries a `class:` directive, which is a separate AST node from the `class` attribute. |
| `each-blocks.svelte` | Keyed and unkeyed `{#each}`. One source range, many rendered occurrences — the case that makes "this element only" a false promise. |
| `branches.svelte` | `{#if}`/`{:else}` and `{#await}`/`{:then}`/`{:catch}`. Only the live branch is rendered, so the ancestry chain must name the branch that actually produced the node. |
| `snippets.svelte` | `{#snippet}` authored in one place and `{@render}`ed in another: authoring site and render site differ, and the inspector must not equate the visual parent with the source owner. |
| `invocations.svelte` + `card.svelte` | Three separately authored `<Card />` calls plus a fourth inside `{#each}`. Distinguishes definition, invocation and occurrence, and is the fixture for editing a literal prop at one verified call site. `card.svelte` also carries component-local `<style>`. |
| `multi-root.svelte` | A component with two root elements — one boundary, several rectangles, so bounds are an array. |
| `empty.svelte` | A component that renders nothing. It has a source entry and no visible rectangle. |
| `unmapped.svelte` | `{@html}`, `<canvas>` and a cross-origin `<iframe>`: visual-only regions whose internals must stay inspect-only. |

Regenerate nothing — these are hand-authored source, not generated output. Add a fixture when a new construct changes mapping behaviour, and say in this table what it pins.
