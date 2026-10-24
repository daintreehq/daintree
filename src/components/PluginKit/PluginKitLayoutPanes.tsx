import { KitBulkActionBar, KitLoadMoreFooter } from "./PluginKitCollectionChrome";
import { KitDrawer, KitDrawerToggle } from "./PluginKitDrawer";
import { KitRefreshOverlay, KitStaleIndicator } from "./PluginKitFreshness";
import { KitGroupedVirtualList } from "./PluginKitGroupedList";
import { KitInspector, KitInspectorSection, KitPropertyRow } from "./PluginKitInspector";
import { KitMasterDetail, KitSplitGroup } from "./PluginKitSplitLayouts";
import { KitTaskList } from "./PluginKitTaskList";

export { groupOffsets } from "./PluginKitGroupedList";
export { readSplitPanes } from "./PluginKitSplitLayouts";
export { taskNews, taskSummary } from "./PluginKitTaskList";

export const pluginKitLayoutPanes = {
  MasterDetail: KitMasterDetail,
  SplitGroup: KitSplitGroup,
  Inspector: KitInspector,
  InspectorSection: KitInspectorSection,
  PropertyRow: KitPropertyRow,
  Drawer: KitDrawer,
  DrawerToggle: KitDrawerToggle,
  GroupedVirtualList: KitGroupedVirtualList,
  BulkActionBar: KitBulkActionBar,
  LoadMoreFooter: KitLoadMoreFooter,
  TaskList: KitTaskList,
  RefreshOverlay: KitRefreshOverlay,
  StaleIndicator: KitStaleIndicator,
};
