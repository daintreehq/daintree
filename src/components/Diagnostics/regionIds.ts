// Leaf module so always-mounted toolbar chrome (ToolbarProblemsButton's
// aria-controls) can reference the dock's region id without statically
// importing DiagnosticsDock — which would pull the dock and its six content
// panels into the first-render chunk, defeating the lazy() boundary in
// AppLayout.
export const DIAGNOSTICS_DOCK_REGION_ID = "diagnostics-dock-region";
