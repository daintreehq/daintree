// The mock Daintree window. Its regions, layout constants and anchor names are
// a contract plugin scenes build on: changing them is a versioned API change.
export {
  ANCHOR,
  APP_LAYOUT,
  GRID_RECT,
  MockApp,
  MockGrid,
  MockWaitingPill,
  MockWorktreeCard,
  TOOLBAR_AGENTS,
} from "./mock-app/MockApp.js";
export type { AppRegion, MockAppProps, MockWorktree } from "./mock-app/MockApp.js";
export { MockPane } from "./mock-app/MockPane.js";
export type { MockPaneProps } from "./mock-app/MockPane.js";
export {
  MockAgentGlyph,
  MockAgentIcon,
  MockAppMark,
  MockStateGlyph,
} from "./mock-app/MockGlyphs.js";
export { MockCIGlyph } from "./mock-app/MockCIGlyph.js";
export { MockEmptyGrid } from "./mock-app/MockEmptyGrid.js";
export {
  EMPTY_MOCK_KIT,
  MockKitContext,
  resolveMockAgent,
  resolveMockCI,
  resolveMockState,
  useMockKit,
} from "./mock-app/MockKitContext.js";
export type {
  MockAgent,
  MockAgentId,
  MockCIVisual,
  MockGlyph,
  MockKit,
  MockStateId,
  MockStateVisual,
} from "./mock-app/MockKitContext.js";
