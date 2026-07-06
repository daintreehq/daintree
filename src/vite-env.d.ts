/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS?: string;
  readonly DAINTREE_PERF_CAPTURE?: string;
  readonly DAINTREE_VERBOSE?: string;
  readonly DAINTREE_DISABLE_FOCUSED_DRAIN_PRIORITY?: string;
  readonly DAINTREE_PAINT_FABRIC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
