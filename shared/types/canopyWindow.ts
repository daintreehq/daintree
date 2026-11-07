// The Canopy-window role rides into the renderer the way the surface-host role
// does (webPreferences.additionalArguments): its presence makes src/main.tsx
// mount Canopy's own root instead of the project app shell. The preload reads
// the same switch; it can't import this at runtime.
export const CANOPY_WINDOW_ARG = "--daintree-window-kind=canopy";
