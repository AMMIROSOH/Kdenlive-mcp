export {
  CURRENT_SCHEMA_VERSION,
  assetSchema,
  captionSchema,
  clipSchema,
  effectSchema,
  frameSchema,
  markerSchema,
  keyframeSchema,
  mediaProbeSchema,
  positiveRationalSchema,
  projectSchema,
  projectSettingsSchema,
  reduceRational,
  trackSchema,
  transitionSchema,
  textOverlaySchema,
  uuidSchema,
  type Asset,
  type Caption,
  type Clip,
  type Effect,
  type Keyframe,
  type Marker,
  type MediaProbe,
  type Project,
  type ProjectSettings,
  type Track,
  type TextOverlay,
  type Transition,
} from './schema.js';
export {
  cloneProject,
  createProject,
  DEFAULT_PROJECT_SETTINGS,
  newId,
} from './project.js';
export {
  deserializeProject,
  parseProject,
  serializeProject,
  UnsupportedProjectVersionError,
} from './serialization.js';
export {
  clipDurationFrames,
  framesToSeconds,
  framesToTimecode,
  multiplyRationals,
  rescaleFrames,
  secondsToFrames,
  type Rational,
  type RoundingMode,
} from './frame-math.js';
export {
  ProjectStore,
  ProjectValidationError,
  RevisionConflictError,
  UndoConflictError,
  type MutationOptions,
  type MutationResult,
} from './store.js';
export {
  FfprobeRunner,
  MediaIngestor,
  type MediaImportOptions,
  type MediaImportResult,
  type MediaProbeRunner,
  type ProbeCache,
} from './media.js';
export {
  validateProject,
  type DiagnosticSeverity,
  type ProjectDiagnostic,
  type ValidationCapabilities,
  type ValidationOptions,
} from './validator.js';
export {
  InvalidTimelineEditError,
  TimelineEditError,
  clipDuration,
  clipEnd,
  type EditResult,
} from './editing.js';
export {
  queryTimeline,
  type TimelineQueryOptions,
  type TimelineView,
} from './timeline-query.js';
export {
  addTrack,
  addClips,
  createTrack,
  type PlacementOptions,
  type PlacementRequest,
} from './placement.js';
export {
  moveClips,
  removeClips,
  rippleDeleteRanges,
  setClipSpeed,
  slipClip,
  splitClip,
  trimClip,
  type RippleRange,
} from './structural.js';
export {
  setClipProperties,
  setKeyframes,
  type ClipPropertyPatch,
} from './properties.js';
export {
  DEFAULT_TEXT_STYLE,
  addCaptions,
  addMarkers,
  addTexts,
  addTransition,
  exportYouTubeChapters,
  removeCaptions,
  removeMarkers,
  removeTexts,
  removeTransition,
  setEffects,
  updateCaptions,
  updateMarkers,
  updateTexts,
  updateTransition,
  type EffectInput,
} from './creative.js';
export { commitEdit } from './edit-transaction.js';
export {
  buildEffectCatalog,
  type EffectCatalog,
  type EffectCatalogEntry,
  type EffectParameterDefinition,
} from './effect-catalog.js';
export { exportSrt, exportVtt, importCaptions } from './caption-io.js';
export {
  captionsFromTranscriptWords,
  generateCaptionsFromTranscript,
  type CaptionDraft,
  type CaptionWorkflowOptions,
  type GenerateCaptionOptions,
  type TranscriptWord,
} from './caption-workflow.js';
