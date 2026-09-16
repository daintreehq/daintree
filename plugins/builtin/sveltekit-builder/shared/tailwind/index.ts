export type {
  CompiledCandidate,
  CompiledDeclaration,
  Declaration,
  DeclarationScope,
  TailwindDesignSystem,
  TailwindLoadResult,
  TailwindProjectRef,
  ThemeEntry,
} from "./designSystem.js";
export { loadTailwindDesignSystem, escapeClassName } from "./designSystem.js";

export type { CandidateDescription, CandidateSlot, DeclarationRole } from "./candidates.js";
export {
  appearsAsLiteralToken,
  candidateScopeKey,
  composeCandidate,
  describeCandidate,
  isRegisterAssembly,
  isRegisterHousekeeping,
  isValidCandidate,
  registersReadBy,
  registersSetBy,
  scopeKey,
  scopeKeyForVariant,
} from "./candidates.js";

export type { Breakpoint, ResponsiveRange } from "./ranges.js";
export {
  BASE_RANGE_VARIANT,
  rangeContaining,
  readBreakpoints,
  resolveResponsiveRanges,
  toPixels,
  variantChainOf,
} from "./ranges.js";

export type { ConflictReport, TokenConflict, WritingDirection } from "./conflicts.js";
export { expandProperty, findConflicts } from "./conflicts.js";

export type {
  AuthoredToken,
  AuthoredValueResult,
  ProposalResult,
  PropertyMapping,
} from "./properties.js";
export { PROPERTY_MAPPINGS, proposeCandidate, readAuthoredValue } from "./properties.js";
