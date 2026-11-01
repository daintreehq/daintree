export {
  buildInputBarTheme,
  chipEntranceTheme,
  setInterimText,
  interimWidgetField,
  setPendingAIRanges,
  pendingAIField,
  COMPOSER_GEOMETRY_EVENT,
  COMPOSER_DRAFT_RESET_ATTR,
  computeAutoSize,
  createAutoSize,
  createCustomKeymap,
  createPlaceholder,
  createContentAttributes,
  createComboboxAttributes,
  createPlainPasteKeymap,
  removeChipRange,
  VOICE_CARET_LEVEL_PROPERTY,
} from "./base";
export { minimalDocChange } from "@/lib/textRangeMapping";
export { pendingLock } from "./pendingLock";
export { userEdit } from "./userEdit";
export { createCaretTracker } from "./caretTracker";
export { completionBoundary, completionBoundaryAt } from "./completionBoundary";
export {
  dictationFollow,
  dictationFollowField,
  revealDictationStart,
  setDictationFollow,
} from "./dictationFollow";
export {
  currentVoiceCaretEffects,
  requestVoiceCaret,
  setVoiceCaret,
  voiceCaret,
  voiceCaretField,
  voiceCaretPosition,
} from "./voiceCaret";
export type { VoiceCaretAt, VoiceCaretPhase } from "./voiceCaret";
export type { AutoSizeConfig, ComboboxAttributes, InterimPreview } from "./base";

export {
  createSlashChipField,
  createSlashTooltip,
  createSlashChipCompartment,
  createSlashTooltipCompartment,
} from "./slashChip";
export { createFileChipField, createFileChipTooltip, isOwnedByAttachmentChip } from "./fileChip";
export {
  addImageChip,
  imageChipField,
  readImageChipPaths,
  createImageChipTooltip,
  createImagePasteHandler,
} from "./imageChip";
export {
  addFileDropChip,
  fileDropChipField,
  createFileDropChipTooltip,
  createFilePasteHandler,
} from "./fileDropChip";
export { diffChipField, createDiffChipTooltip } from "./diffChip";
export { terminalChipField, createTerminalChipTooltip } from "./terminalChip";
export { selectionChipField, createSelectionChipTooltip } from "./selectionChip";
export {
  applyContextReferenceProviders,
  currentContextReferenceProvidersEffects,
  contextReferenceChipField,
  contextReferenceChipProviders,
  createContextReferenceChipTooltip,
  isOwnedByContextReferenceChip,
  setContextReferenceProviders,
} from "./contextReferenceChip";
export {
  applyForgeReferences,
  createForgeReferenceTooltip,
  eligibleIssueReferences,
  forgeReferenceField,
  onForgeReferenceRescan,
  rescanForgeReferences,
} from "./forgeReference";
export type { ForgeReferenceMap } from "./forgeReference";
export {
  chipPendingDeleteField,
  setChipPendingDelete,
  createChipBackspaceKeymap,
  isChipSelected,
} from "./chipBackspace";
export type { ChipPendingDelete } from "./chipBackspace";
export { createCursorBlink } from "./cursorBlink";
export {
  createComposerHistory,
  clearComposerHistory,
  dictationWrite,
  outsideDraftWrite,
  selectionAfterOutsideWrite,
} from "./composerHistory";
export {
  correctionLanded,
  createCorrectionReview,
  endCorrectionReview,
  replayLandedCorrection,
} from "./correctionReview";
export type { CorrectionReview } from "./correctionReview";
export { captureRewriteSelection, voiceRewriteTracker } from "./voiceRewrite";
