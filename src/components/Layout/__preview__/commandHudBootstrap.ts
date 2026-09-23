// Imported FIRST by commandHud.tsx so the bridge shim exists before any module
// that reaches for `window.electron` at evaluation time — ES imports evaluate
// in source order, which is the only ordering guarantee the harness has.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

installPreviewShims();
