/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS?: string;
  readonly DAINTREE_PERF_CAPTURE?: string;
  readonly DAINTREE_VERBOSE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
