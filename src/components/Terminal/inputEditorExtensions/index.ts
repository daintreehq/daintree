export {
  inputTheme,
  setInterimRange,
  interimMarkField,
  setPendingAIRanges,
  pendingAIField,
  computeAutoSize,
  createAutoSize,
  createCustomKeymap,
  createPlaceholder,
  createContentAttributes,
  createPlainPasteKeymap,
  formatFileSize,
  removeChipRange,
} from "./base";
export type { AutoSizeConfig } from "./base";

export {
  createSlashChipField,
  createSlashTooltip,
  createSlashChipCompartment,
  createSlashTooltipCompartment,
} from "./slashChip";
export { createFileChipField, createFileChipTooltip } from "./fileChip";
export {
  addImageChip,
  imageChipField,
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
