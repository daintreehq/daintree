// Types for `@daintreehq/plugin-ui`, the UI components Daintree serves to
// plugin views through its import map. There is no package behind the
// specifier — the implementation only exists inside the running app, and
// `@daintreehq/plugin-vite` keeps it external — so this ambient declaration is
// how TypeScript learns its shape. Opt in with
// `"types": ["@daintreehq/plugin-sdk/plugin-ui"]` in tsconfig, or
// `/// <reference types="@daintreehq/plugin-sdk/plugin-ui" />` in one file.
declare module "@daintreehq/plugin-ui" {
  import type { ComponentType } from "react";
  import type { PluginMarkdownProps } from "@daintreehq/plugin-sdk/react";

  export type MarkdownProps = PluginMarkdownProps;

  /**
   * Daintree's own Markdown renderer: GFM, highlighted code fences, the app's
   * document typography, and raw HTML dropped rather than rendered. Loads on
   * first render, so it can paint one frame late.
   */
  export const Markdown: ComponentType<MarkdownProps>;
}
