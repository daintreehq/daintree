// Imported FIRST by preview.tsx so the bridge shim exists before any module
// that reaches for `window.electron` at evaluation time. ES module imports are
// hoisted but evaluated in source order, which is the only ordering guarantee
// the harness has — see the note at the top of the HelpPanel preview.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

installPreviewShims();
