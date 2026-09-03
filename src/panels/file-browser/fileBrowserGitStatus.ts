// Re-export of the canonical changed-file status index shipped as
// `@daintreehq/plugin-sdk/files`. The implementation lives in the package
// source so the published SDK and the host bundle run identical code; this
// shim keeps the in-repo `./fileBrowserGitStatus` import path stable.
export * from "../../../packages/plugin-sdk/src/files/gitStatus";
