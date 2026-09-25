// Supplied at build time by `pluginStyleContractEsbuild()` (tsup.config.ts) and
// in tests by the root vitest config's `pluginStyleContract()`.
declare module "virtual:daintree-plugin-style-contract" {
  export const designContractCss: string;
  export const tailwindThemeCss: string;
  export const tailwindUtilitiesCss: string;
  export const twAnimateCss: string;
  export const tailwindPreflightCss: string;
}
