// Imported FIRST by the preview entry so the bridge shim exists before any
// module that reaches for `window.electron` at evaluation time. Not the Layout
// bootstrap: that also freezes `Date.now`, which holds the skeleton's onset
// gate shut and photographs the loading branch as an empty column.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

installPreviewShims();
