import { lazy, Suspense } from "react";
import type { PluginMarkdownProps } from "@shared/types/plugin-sdk-react";

// Behind a dynamic import on purpose. The plugin-ui facade is a build entry, so
// anything imported statically from here counts as startup code and the `boot`
// chunk would absorb it (see vite.config.ts). Loaded lazily, the renderer stays
// in the chunks the host's own Markdown surfaces already share.
const PluginMarkdown = lazy(() => import("@/components/Markdown/PluginMarkdown"));

export function Markdown(props: PluginMarkdownProps) {
  // Nothing, not a loading state: the renderer is a local app:// chunk, well
  // under the 400ms Doherty gate, and a document-sized block has no shape
  // worth a skeleton. A deferred indicator would also pull app modules into
  // this chunk's static graph, which must stay React-only.
  return (
    <Suspense fallback={null}>
      <PluginMarkdown {...props} />
    </Suspense>
  );
}
