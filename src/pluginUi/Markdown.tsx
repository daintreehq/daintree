import { lazy, Suspense } from "react";
import type { PluginMarkdownProps } from "@shared/types/plugin-sdk-react";

// Behind a dynamic import on purpose. The plugin-ui facade is a build entry, so
// anything imported statically from here counts as startup code and the `boot`
// chunk would absorb it (see vite.config.ts). Loaded lazily, the renderer stays
// in the chunks the host's own Markdown surfaces already share.
const PluginMarkdown = lazy(() => import("@/components/Markdown/PluginMarkdown"));

export function Markdown(props: PluginMarkdownProps) {
  return (
    <Suspense fallback={null}>
      <PluginMarkdown {...props} />
    </Suspense>
  );
}
