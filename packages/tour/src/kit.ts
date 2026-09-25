// Generic scene tools: timing-driven primitives on the fixed tour canvas.
// Nothing here knows about Daintree's window; that lives in `./mock-app`.
export { cn } from "./kit/cn.js";
export { measureAnchor } from "./kit/tourAnchors.js";
export type { CanvasRect } from "./kit/tourAnchors.js";
export { TOUR_CANVAS, TourCanvas } from "./kit/TourCanvas.js";
export {
  PLAIN_TOUR_SHORTCUTS,
  TourShortcutsContext,
  useTourShortcuts,
} from "./kit/TourShortcuts.js";
export type { TourKeyboard, TourShortcuts } from "./kit/TourShortcuts.js";
export {
  MockCursor,
  MockFocusRing,
  MockLines,
  MockStreamingLines,
  MockTyping,
  reveal,
  typingRate,
  useMockCursor,
} from "./kit/TourMock.js";
export type { CursorAnchor, CursorStep, CursorStop, CursorTarget } from "./kit/TourMock.js";
export {
  MockCallout,
  MockKeys,
  MockLegend,
  MockMenu,
  MockPanel,
  MockSearchField,
  MockSpotlight,
  MockTooltip,
} from "./kit/sceneParts.js";
export type { LegendItem, MockMenuItem } from "./kit/sceneParts.js";
