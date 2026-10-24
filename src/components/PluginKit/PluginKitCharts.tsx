import { KitBarChart } from "./PluginKitBarChart";
import { KitLineChart } from "./PluginKitLineChart";
import { KitDonutChart } from "./PluginKitDonutChart";

export {
  MAX_SERIES,
  MAX_TABLE_ROWS,
  SERIES_DASHES,
  X_TICK_SPACING,
  axisTicks,
  barPath,
  chartColor,
  decimate,
  edgeAnchor,
  monotonePath,
  niceTicks,
  resolveSeries,
  timeTicks,
  withoutOverlaps,
} from "./kitChartModel";
export { tooltipLeft } from "./kitChartFrame";
export { donutParts } from "./PluginKitDonutChart";

export const pluginKitCharts = {
  BarChart: KitBarChart,
  LineChart: KitLineChart,
  DonutChart: KitDonutChart,
};
