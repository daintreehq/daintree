# `__svelte_meta` shape corpus

The shapes the guest runtime's capability probe is tested against. `__svelte_meta` is a private detail of Svelte's dev runtime, so a supported major is not a promise about its shape: the runtime reads it defensively and reports what it found (`metadataProbed`), and the host narrows what it offers to match. Each file is one element's metadata as the runtime would see it; the probe's answer for it is the contract.

| Fixture | Shape | Probe answer |
| --- | --- | --- |
| `loc-and-parent.json` | `loc` plus a `parent` chain of frames — the shape verified against the pinned Svelte 5 baseline. | `locations: true, ancestry: true` |
| `loc-only.json` | `loc` with no `parent` — a runtime that stamps elements but keeps no dev stack. | `locations: true, ancestry: false` |
| `blocks-only.json` | `loc` with a `parent` chain of block frames (`each`, `if`) and no tagged component invocation — readable, but nothing the trail could hand to a crumb. | `locations: true, ancestry: false` |
| `malformed.json` | A stamp whose `loc` names no file and whose frames carry no positions — a shape the reader cannot follow. | `locations: false, ancestry: false` |

Add a fixture when a Svelte release changes the shape, and say in this table what the probe must answer for it.
