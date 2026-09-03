// Re-export of the canonical file-tree model shipped as
// `@daintreehq/plugin-sdk/files`. The implementation lives in the package
// source so the published SDK and the host bundle run identical code — the
// built-in file browser is the reference consumer of the same tree model a
// plugin building its own browser gets. This shim keeps the in-repo
// `./fileBrowserTree` import path stable for the panel's own modules.
export * from "../../../packages/plugin-sdk/src/files/fileTree";
