import { useEffect, useMemo } from "react";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import { useChromeWhenContext } from "@/hooks/useChromeWhenContext";
import { getChromeWhenContext } from "@/services/chromeWhenContext";
import { resolveSidebarViewOptions, type SidebarViewOption } from "@/lib/sidebarViews";

/**
 * The sidebar views on offer in this project view, live: a plugin's view comes
 * and goes as its plugin loads, stops or is hidden here, and as its `when`
 * changes. Starts the hosted-view snapshot itself, since nothing else does
 * until a settings home opens.
 */
export function useSidebarViewOptions(): readonly SidebarViewOption[] {
  const hosted = usePluginHostedViewsStore((s) => s.views);
  const initHosted = usePluginHostedViewsStore((s) => s.init);
  const context = useChromeWhenContext();

  useEffect(() => {
    initHosted();
  }, [initHosted]);

  return useMemo(() => resolveSidebarViewOptions(hosted, context), [hosted, context]);
}

/** Non-reactive snapshot of {@link useSidebarViewOptions}, for actions. */
export function getSidebarViewOptions(): SidebarViewOption[] {
  return resolveSidebarViewOptions(
    usePluginHostedViewsStore.getState().views,
    getChromeWhenContext()
  );
}
