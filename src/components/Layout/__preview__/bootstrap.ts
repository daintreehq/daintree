// Imported FIRST by preview.tsx so the bridge shim exists before any module
// that reaches for `window.electron` at evaluation time. ES module imports are
// hoisted but evaluated in source order, which is the only ordering guarantee
// the harness has.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

installPreviewShims();

/**
 * Freeze wall-clock time before anything reads it.
 *
 * Every row in this surface renders `expiresAt - Date.now()`, so a live clock
 * makes each capture a different picture: the seconds drift between the page
 * load and the screenshot, and the 5-second "critical" threshold trips
 * somewhere in the middle of a theme sweep. Freezing `Date.now` pins each
 * fixture to the remaining-time it declares, so a diff between two rounds is a
 * diff in the design and not in how long the dev server took to compile.
 *
 * Fixtures build their `expiresAt` off this same constant — see `FROZEN_NOW`.
 */
export const FROZEN_NOW = 1_764_000_000_000;
Date.now = () => FROZEN_NOW;
