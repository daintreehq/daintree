/**
 * Library surface for `daintree-plugin`. Consumed by `create-daintree-plugin`
 * (the `npm create daintree-plugin` shim) to reuse the scaffold entry point.
 */
export { runNew, scaffoldPlugin } from "./commands/new.js";
export { runNewFromArgv } from "./commands/newCommand.js";
export type { ScaffoldPluginOptions, ScaffoldResult } from "./commands/new.js";
export { runValidate } from "./commands/validate.js";
export type { ValidateOptions, ValidateResult } from "./commands/validate.js";
export { runDoctor } from "./commands/doctor.js";
export type {
  DoctorOptions,
  DoctorResult,
  DoctorPluginReport,
  DoctorHostReport,
} from "./commands/doctor.js";
export { runSchema } from "./commands/schema.js";
export type { SchemaOptions } from "./commands/schema.js";
export { runPackage } from "./commands/package.js";
export type { PackageOptions, PackageResult } from "./commands/package.js";
export { runTourAlign, runTourVoice } from "./commands/tour.js";
export type {
  TourAlignOptions,
  TourChapterOutcome,
  TourChapterReport,
  TourCommandResult,
  TourVoiceOptions,
} from "./commands/tour.js";
export { runTourPreview } from "./commands/tourPreview.js";
export type { TourPreviewOptions, TourPreviewResult } from "./commands/tourPreview.js";
export type { CaptureChapter, CaptureFrame, CaptureManifest } from "./tour/preview/capture.js";
export { runInstall } from "./commands/install.js";
export { runUninstall } from "./commands/uninstall.js";
export { TEMPLATE_KINDS, type TemplateKind } from "./scaffold/templates.js";
