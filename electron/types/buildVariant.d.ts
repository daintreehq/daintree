declare const IS_LEGACY_BUILD: boolean;

declare namespace NodeJS {
  interface ProcessEnv {
    readonly BUILD_VARIANT?: "daintree" | "canopy";
  }
}
