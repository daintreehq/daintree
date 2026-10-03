import type { PluginRendererMetricsReport } from "../pluginMetrics.js";

/**
 * One renderer report as it crosses `plugin:report-view-metrics`, tagged with
 * the plugin load it was observed against.
 *
 * `generation` is the `plugin://` authority of the view module the report came
 * from. Main mints a fresh authority for every load and never reissues one, so
 * it is the load's identity: a report buffered across an unload and a same-id
 * reload names the retired authority, and main drops it rather than folding the
 * old load's numbers into the new one's freshly evicted metrics.
 */
export interface PluginRendererMetricsEnvelope {
  generation: string;
  report: PluginRendererMetricsReport;
}
