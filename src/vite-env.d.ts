/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS?: string;
  readonly CANOPY_PERF_CAPTURE?: string;
  readonly CANOPY_VERBOSE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
