import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DEFAULT_PROJECT_SETTINGS,
  InvalidTimelineEditError,
  addCaptions,
  addClips,
  addMarkers,
  addTexts,
  addTrack,
  addTransition,
  generateCaptionsFromTranscript,
  exportSrt,
  exportVtt,
  moveClips,
  removeCaptions,
  removeClips,
  removeMarkers,
  removeTexts,
  removeTransition,
  rippleDeleteRanges,
  setClipProperties,
  setClipSpeed,
  setEffects,
  setKeyframes,
  slipClip,
  splitClip,
  trimClip,
  updateCaptions,
  updateMarkers,
  updateTexts,
  updateTransition,
  type EditResult,
  type ProjectSettings,
} from '@kdenlive-mcp/project-core';
import {
  BUILTIN_EXPORT_PROFILES,
  MeltBusyError,
} from '@kdenlive-mcp/render-core';

import { AGENT_INSTRUCTIONS } from './instructions.js';
import { WorkspaceService } from './workspace.js';
import { APP_VERSION } from './version.js';
import { EDITING_RECIPES, recipe } from './recipes.js';

const projectId = z.string().uuid();
const expectedRevision = z.number().int().nonnegative();
const entityId = z.string().uuid();
const unknownRecord = z.record(z.string(), z.unknown());
const clipTransformPatchSchema = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    rotation: z.number().optional(),
  })
  .strict();
const clipCropPatchSchema = z
  .object({
    top: z.number().nonnegative().optional(),
    right: z.number().nonnegative().optional(),
    bottom: z.number().nonnegative().optional(),
    left: z.number().nonnegative().optional(),
  })
  .strict();
const clipAudioPatchSchema = z
  .object({
    volume: z.number().nonnegative().optional(),
    pan: z.number().min(-1).max(1).optional(),
    muted: z.boolean().optional(),
  })
  .strict();
const clipPropertyPatchSchema = z
  .object({
    transform: clipTransformPatchSchema.optional(),
    crop: clipCropPatchSchema.optional(),
    opacity: z.number().min(0).max(1).optional(),
    audio: clipAudioPatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one clip property is required',
  });
const clipPropertyUpdateSchema = z
  .object({
    clipId: entityId,
    properties: clipPropertyPatchSchema,
  })
  .strict();
const captionStyleSchema = z
  .object({
    preset: z.string().min(1),
    position: z.enum(['top', 'center', 'bottom']),
  })
  .strict();
const captionAddItemSchema = z
  .object({
    id: entityId.optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text: z.string().min(1),
    style: captionStyleSchema,
  })
  .strict();
const captionUpdateItemSchema = z
  .object({
    id: entityId,
    patch: z
      .object({
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().positive().optional(),
        text: z.string().min(1).optional(),
        style: captionStyleSchema.partial().strict().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: 'At least one caption field is required',
      }),
  })
  .strict();
const transcriptWordSchema = z
  .object({
    text: z.string().min(1).max(200),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
const projectSettingsOverridesSchema = z
  .object({
    fps: z
      .object({
        numerator: z.int().positive(),
        denominator: z.int().positive(),
      })
      .optional(),
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
    audioSampleRate: z.int().positive().optional(),
    color: z
      .object({
        primaries: z.enum(['bt601', 'bt709', 'bt2020']).optional(),
        transfer: z.enum(['bt601', 'bt709', 'srgb', 'pq', 'hlg']).optional(),
        matrix: z.enum(['bt601', 'bt709', 'bt2020-ncl']).optional(),
        range: z.enum(['limited', 'full']).optional(),
      })
      .optional(),
    exportDefaults: z
      .object({
        profile: z.string().min(1).optional(),
        videoCodec: z.string().min(1).optional(),
        audioCodec: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

type ProjectSettingsOverrides = z.infer<typeof projectSettingsOverridesSchema>;

const mediaExportProfileIds = BUILTIN_EXPORT_PROFILES.filter(
  (profile) => profile.delivery === 'media',
).map((profile) => profile.id);
const interchangePlanSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('roundtrip'),
      sourcePath: z.string().min(1).max(4096),
      format: z.enum(['kdenlive', 'otio']),
      projectId,
      expectedRevision,
      relinks: z
        .array(
          z
            .object({ sourcePath: z.string(), replacementPath: z.string() })
            .strict(),
        )
        .max(100)
        .optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('new-project'),
      sourcePath: z.string().min(1).max(4096),
      format: z.enum(['kdenlive', 'otio']),
      destinationPath: z.string().min(1).max(4096),
      destinationName: z.string().min(1).max(200),
      relinks: z
        .array(
          z
            .object({ sourcePath: z.string(), replacementPath: z.string() })
            .strict(),
        )
        .max(100)
        .optional(),
    })
    .strict(),
]);

function assertMediaExportProfile(profileId: string): void {
  if (mediaExportProfileIds.includes(profileId)) return;
  throw new Error(
    `Unknown media export profile: ${profileId}. Valid profile IDs: ${mediaExportProfileIds.join(', ')}`,
  );
}

function resolveProjectSettings(
  overrides: ProjectSettingsOverrides | undefined,
): ProjectSettings {
  if (overrides === undefined) return structuredClone(DEFAULT_PROJECT_SETTINGS);
  const settings: ProjectSettings = {
    fps: overrides.fps ?? DEFAULT_PROJECT_SETTINGS.fps,
    width: overrides.width ?? DEFAULT_PROJECT_SETTINGS.width,
    height: overrides.height ?? DEFAULT_PROJECT_SETTINGS.height,
    audioSampleRate:
      overrides.audioSampleRate ?? DEFAULT_PROJECT_SETTINGS.audioSampleRate,
    color: {
      primaries:
        overrides.color?.primaries ?? DEFAULT_PROJECT_SETTINGS.color.primaries,
      transfer:
        overrides.color?.transfer ?? DEFAULT_PROJECT_SETTINGS.color.transfer,
      matrix: overrides.color?.matrix ?? DEFAULT_PROJECT_SETTINGS.color.matrix,
      range: overrides.color?.range ?? DEFAULT_PROJECT_SETTINGS.color.range,
    },
    exportDefaults: {
      profile:
        overrides.exportDefaults?.profile ??
        DEFAULT_PROJECT_SETTINGS.exportDefaults.profile,
      videoCodec:
        overrides.exportDefaults?.videoCodec ??
        DEFAULT_PROJECT_SETTINGS.exportDefaults.videoCodec,
      audioCodec:
        overrides.exportDefaults?.audioCodec ??
        DEFAULT_PROJECT_SETTINGS.exportDefaults.audioCodec,
    },
  };
  assertMediaExportProfile(settings.exportDefaults.profile);
  return settings;
}

type ToolEnvelope = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
};

function success(data: unknown) {
  const envelope: ToolEnvelope = { ok: true, data };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'INTERNAL_ERROR';
  if (error.name === 'RevisionConflictError') return 'REVISION_CONFLICT';
  if (error.name === 'ProjectValidationError') return 'PROJECT_INVALID';
  if (error.name === 'TimelineEditError') return 'TIMELINE_EDIT_INVALID';
  if (error.name === 'InvalidTimelineEditError') return 'TIMELINE_EDIT_INVALID';
  if (error.name === 'ZodError') return 'INVALID_ARGUMENTS';
  if (error.name === 'MeltExecutionError') return 'MELT_EXECUTION_FAILED';
  if (error.name === 'MeltBusyError') return 'MELT_BUSY';
  if (error.message.includes('outside configured roots'))
    return 'PATH_OUTSIDE_ROOTS';
  if (error.message.includes('another client')) return 'JOB_FORBIDDEN';
  if (error.message.includes('not found') || error.message.includes('not open'))
    return 'NOT_FOUND';
  return 'OPERATION_FAILED';
}

async function guarded(action: () => Promise<unknown> | unknown) {
  try {
    return success(await action());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const envelope: ToolEnvelope = {
      ok: false,
      error: {
        code: errorCode(cause),
        message: message.slice(0, 2_000),
        ...(cause instanceof MeltBusyError
          ? { details: { retryable: cause.retryable } }
          : cause instanceof InvalidTimelineEditError
            ? {
                details: {
                  diagnostics: cause.diagnostics.slice(0, 100),
                  truncated: cause.diagnostics.length > 100,
                },
              }
            : cause instanceof Error && cause.name === 'MeltExecutionError'
              ? {
                  details: {
                    failureCategory: Reflect.get(cause, 'category'),
                    executable: Reflect.get(cause, 'executable'),
                    nativeExitCode: Reflect.get(cause, 'nativeExitCode'),
                    nativeExitCodeHex: Reflect.get(cause, 'nativeExitCodeHex'),
                    meltInvoked: true,
                  },
                }
              : {}),
      },
    };
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      structuredContent: envelope,
    };
  }
}

export interface ServerSessionOptions {
  readonly clientId: string;
  readonly workspace: WorkspaceService;
}

export function createMcpServer(options: ServerSessionOptions): McpServer {
  const { clientId, workspace } = options;
  const server = new McpServer(
    { name: 'kdenlive-mcp', version: APP_VERSION },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    'project_create',
    {
      description:
        'Create and open a canonical project inside an allowed root.',
      inputSchema: {
        path: z.string().min(1).max(1_024),
        name: z.string().min(1).max(200),
        settings: projectSettingsOverridesSchema.optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ path, name, settings }) =>
      await guarded(
        async () =>
          await workspace.createProject({
            path,
            name,
            settings: resolveProjectSettings(settings),
          }),
      ),
  );

  server.registerTool(
    'project_open',
    {
      description: 'Open a project store inside an allowed root.',
      inputSchema: { path: z.string().min(1).max(1_024) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) =>
      await guarded(async () => await workspace.openProject(path)),
  );

  server.registerTool(
    'project_get',
    {
      description: 'Read the open canonical project and current revision.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectId: id }) => guarded(() => workspace.project(id)),
  );

  server.registerTool(
    'project_validate',
    {
      description: 'Run deterministic full-project validation.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectId: id }) => guarded(async () => await workspace.validate(id)),
  );

  server.registerTool(
    'project_checkpoint',
    {
      description: 'Create or replace a named checkpoint.',
      inputSchema: { projectId, name: z.string().min(1).max(100) },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ projectId: id, name }) => guarded(() => workspace.checkpoint(id, name)),
  );

  server.registerTool(
    'project_checkpoint_restore',
    {
      description: 'Restore a named checkpoint as a new revision.',
      inputSchema: {
        projectId,
        name: z.string().min(1).max(100),
        expectedRevision,
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ projectId: id, name, expectedRevision: revision }) =>
      guarded(
        async () =>
          await workspace.restoreCheckpoint(id, name, revision, clientId),
      ),
  );

  for (const [name, action] of [
    ['project_undo', 'undo'],
    ['project_redo', 'redo'],
  ] as const) {
    server.registerTool(
      name,
      {
        description: `${action === 'undo' ? 'Undo' : 'Redo'} this client's latest eligible mutation.`,
        inputSchema: { projectId, expectedRevision },
        annotations: { destructiveHint: true, openWorldHint: false },
      },
      ({ projectId: id, expectedRevision: revision }) =>
        guarded(async () =>
          action === 'undo'
            ? await workspace.undo(id, revision, clientId)
            : await workspace.redo(id, revision, clientId),
        ),
    );
  }

  server.registerTool(
    'media_import',
    {
      description:
        'Import allowed-root media using managed-copy or external-reference mode.',
      inputSchema: {
        projectId,
        expectedRevision,
        paths: z.array(z.string().min(1).max(1_024)).min(1).max(1_000),
        mode: z.enum(['external', 'managed']),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ projectId: id, expectedRevision: revision, paths, mode }) =>
      guarded(
        async () =>
          await workspace.importMedia({
            projectId: id,
            expectedRevision: revision,
            clientId,
            paths,
            mode,
          }),
      ),
  );

  server.registerTool(
    'media_list',
    {
      description: 'List assets in an open project.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectId: id }) => guarded(() => workspace.project(id).assets),
  );

  server.registerTool(
    'media_inspect',
    {
      description: 'Read one imported asset and normalized probe metadata.',
      inputSchema: { projectId, assetId: entityId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectId: id, assetId }) =>
      guarded(() => {
        const asset = workspace
          .project(id)
          .assets.find((candidate) => candidate.id === assetId);
        if (asset === undefined) throw new Error(`Asset not found: ${assetId}`);
        return asset;
      }),
  );

  server.registerTool(
    'timeline_query',
    {
      description: 'Read a bounded, filtered, stably ordered timeline summary.',
      inputSchema: { projectId, options: unknownRecord.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectId: id, options: queryOptions }) =>
      guarded(() =>
        workspace.timeline(
          id,
          (queryOptions ?? {}) as Parameters<typeof workspace.timeline>[1],
        ),
      ),
  );

  const mutation = <T extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: T,
    edit: (
      project: ReturnType<WorkspaceService['project']>,
      input: z.output<z.ZodObject<T>>,
    ) => Promise<EditResult>,
  ): void => {
    const callback = (input: Record<string, unknown>) =>
      guarded(
        async () =>
          await workspace.mutate(
            String(input.projectId),
            Number(input.expectedRevision),
            clientId,
            name,
            async (project) =>
              await edit(project, input as unknown as z.output<z.ZodObject<T>>),
          ),
      );
    server.registerTool(
      name,
      {
        description,
        inputSchema: { projectId, expectedRevision, ...shape },
        annotations: { destructiveHint: true, openWorldHint: false },
      },
      callback as never,
    );
  };

  mutation(
    'timeline_add_track',
    'Add a video or audio track.',
    {
      kind: z.enum(['video', 'audio']),
      name: z.string().min(1).max(100).optional(),
    },
    async (project, input) => await addTrack(project, input.kind, input.name),
  );
  mutation(
    'timeline_add_clips',
    'Add, append, insert, or overwrite a batch of clips.',
    {
      requests: z.array(unknownRecord).min(1).max(500),
      options: unknownRecord,
    },
    async (project, input) =>
      await addClips(
        project,
        input.requests as unknown as Parameters<typeof addClips>[1],
        input.options as unknown as Parameters<typeof addClips>[2],
      ),
  );
  mutation(
    'timeline_move_clips',
    'Move clips with linkage and collision rules.',
    { clipIds: z.array(entityId).min(1).max(500), options: unknownRecord },
    async (project, input) =>
      await moveClips(
        project,
        input.clipIds,
        input.options as Parameters<typeof moveClips>[2],
      ),
  );
  mutation(
    'timeline_remove_clips',
    'Remove clips as one mutation.',
    {
      clipIds: z.array(entityId).min(1).max(500),
      includeLinked: z.boolean().default(true),
    },
    async (project, input) =>
      await removeClips(project, input.clipIds, {
        includeLinked: input.includeLinked,
      }),
  );
  mutation(
    'timeline_split_clip',
    'Split a clip and optionally linked clips.',
    {
      clipId: entityId,
      frame: z.number().int().nonnegative(),
      includeLinked: z.boolean().default(true),
    },
    async (project, input) =>
      await splitClip(project, input.clipId, input.frame, {
        includeLinked: input.includeLinked,
      }),
  );
  mutation(
    'timeline_trim_clip',
    'Trim a clip source range.',
    { clipId: entityId, options: unknownRecord },
    async (project, input) =>
      await trimClip(
        project,
        input.clipId,
        input.options as Parameters<typeof trimClip>[2],
      ),
  );
  mutation(
    'timeline_slip_clip',
    'Slip source media without moving the clip.',
    { clipId: entityId, sourceDelta: z.number().int() },
    async (project, input) =>
      await slipClip(project, input.clipId, input.sourceDelta),
  );
  mutation(
    'timeline_set_speed',
    'Set rational clip speed.',
    { clipId: entityId, speed: unknownRecord },
    async (project, input) =>
      await setClipSpeed(
        project,
        input.clipId,
        input.speed as Parameters<typeof setClipSpeed>[2],
      ),
  );
  mutation(
    'timeline_ripple_delete',
    'Ripple-delete normalized frame ranges.',
    { ranges: z.array(unknownRecord).min(1).max(500) },
    async (project, input) =>
      await rippleDeleteRanges(
        project,
        input.ranges as unknown as Parameters<typeof rippleDeleteRanges>[1],
      ),
  );
  mutation(
    'clip_set_properties',
    'Set batched transform, crop, opacity, and audio properties.',
    { updates: z.array(clipPropertyUpdateSchema).min(1).max(500) },
    async (project, input) =>
      await setClipProperties(
        project,
        input.updates as unknown as Parameters<typeof setClipProperties>[1],
      ),
  );
  mutation(
    'clip_set_keyframes',
    'Replace batched property keyframes.',
    { updates: z.array(unknownRecord).min(1).max(500) },
    async (project, input) =>
      await setKeyframes(
        project,
        input.updates as unknown as Parameters<typeof setKeyframes>[1],
      ),
  );
  mutation(
    'clip_set_effects',
    'Replace an ordered clip effect stack.',
    { clipId: entityId, effects: z.array(unknownRecord).max(100) },
    async (project, input) =>
      await setEffects(
        project,
        input.clipId,
        input.effects as unknown as Parameters<typeof setEffects>[2],
      ),
  );

  mutation(
    'transition_edit',
    'Add, update, or remove one transition.',
    {
      action: z.enum(['add', 'update', 'remove']),
      transitionId: entityId.optional(),
      transition: unknownRecord.optional(),
    },
    async (project, input) => {
      if (input.action === 'add')
        return await addTransition(
          project,
          input.transition as Parameters<typeof addTransition>[1],
        );
      if (input.transitionId === undefined)
        throw new Error('transitionId is required');
      if (input.action === 'remove')
        return await removeTransition(project, input.transitionId);
      return await updateTransition(
        project,
        input.transitionId,
        input.transition as Parameters<typeof updateTransition>[2],
      );
    },
  );

  const timedEdit = (
    kind: 'text' | 'caption' | 'marker',
    add: typeof addTexts | typeof addCaptions | typeof addMarkers,
    update: typeof updateTexts | typeof updateCaptions | typeof updateMarkers,
    remove: typeof removeTexts | typeof removeCaptions | typeof removeMarkers,
  ): void => {
    mutation(
      `${kind}_edit`,
      `Add, update, or remove ${kind} entities as one mutation.`,
      {
        action: z.enum(['add', 'update', 'remove']),
        items: z.array(unknownRecord).max(500).default([]),
        ids: z.array(entityId).max(500).default([]),
      },
      async (project, input) => {
        if (input.action === 'add')
          return await add(project, input.items as never);
        if (input.action === 'update')
          return await update(project, input.items as never);
        return await remove(project, input.ids);
      },
    );
  };
  timedEdit('text', addTexts, updateTexts, removeTexts);
  mutation(
    'caption_edit',
    'Add, update, or remove timed captions as one mutation.',
    {
      action: z.enum(['add', 'update', 'remove']),
      items: z
        .array(z.union([captionAddItemSchema, captionUpdateItemSchema]))
        .max(500)
        .default([]),
      ids: z.array(entityId).max(500).default([]),
    },
    async (project, input) => {
      if (input.action === 'add')
        return await addCaptions(
          project,
          z
            .array(captionAddItemSchema)
            .parse(input.items) as unknown as Parameters<typeof addCaptions>[1],
        );
      if (input.action === 'update')
        return await updateCaptions(
          project,
          z
            .array(captionUpdateItemSchema)
            .parse(input.items) as unknown as Parameters<
            typeof updateCaptions
          >[1],
        );
      return await removeCaptions(project, input.ids);
    },
  );
  mutation(
    'caption_generate',
    'Convert timestamped transcript words into editable captions. The default YouTube layout repeats the prior line above each new line.',
    {
      words: z.array(transcriptWordSchema).min(1).max(10_000),
      layout: z.enum(['standard', 'youtube']).default('youtube'),
      maxLineCharacters: z.number().int().min(1).max(120).default(28),
      minGapFrames: z.number().int().min(0).max(300).default(0),
      maxDurationFrames: z.number().int().min(1).max(3_600).default(180),
      preset: z.string().min(1).max(100).optional(),
      position: z.enum(['top', 'center', 'bottom']).default('bottom'),
      replaceExisting: z.boolean().default(false),
    },
    async (project, input) =>
      await generateCaptionsFromTranscript(project, input.words, {
        layout: input.layout,
        maxLineCharacters: input.maxLineCharacters,
        minGapFrames: input.minGapFrames,
        maxDurationFrames: input.maxDurationFrames,
        ...(input.preset === undefined ? {} : { preset: input.preset }),
        position: input.position,
        replaceExisting: input.replaceExisting,
      }),
  );
  timedEdit('marker', addMarkers, updateMarkers, removeMarkers);

  server.registerTool(
    'caption_export',
    {
      description:
        'Export deterministic SRT or WebVTT captions into project artifacts.',
      inputSchema: {
        projectId,
        format: z.enum(['srt', 'vtt']),
        outputName: z.string().min(1).max(128),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ projectId: id, format, outputName }) =>
      guarded(async () => {
        const project = workspace.project(id);
        const contents =
          format === 'srt'
            ? exportSrt(project.captions, project.settings.fps)
            : exportVtt(project.captions, project.settings.fps);
        return await workspace.writeCaptionExport(
          id,
          outputName,
          contents,
          format === 'srt' ? '.srt' : '.vtt',
        );
      }),
  );

  server.registerTool(
    'interchange_export',
    {
      description:
        'Export the current canonical project as an editable Kdenlive 26.04.x project or OTIO 0.18.1 timeline.',
      inputSchema: {
        projectId,
        format: z.enum(['kdenlive', 'otio']),
        outputName: z.string().min(1).max(128),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ projectId: id, format, outputName }) =>
      guarded(
        async () =>
          await workspace.exportInterchange({
            projectId: id,
            format,
            outputName,
            clientId,
          }),
      ),
  );
  server.registerTool(
    'interchange_import_plan',
    {
      description:
        'Parse a Kdenlive or OTIO file and create a client-owned reviewed import plan. It does not mutate any project.',
      inputSchema: interchangePlanSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      guarded(async () => {
        if (input.mode === 'roundtrip')
          return await workspace.createInterchangePlan({
            clientId,
            sourcePath: input.sourcePath,
            format: input.format,
            mode: input.mode,
            projectId: input.projectId,
            expectedRevision: input.expectedRevision,
          });
        return await workspace.createInterchangePlan({
          clientId,
          sourcePath: input.sourcePath,
          format: input.format,
          mode: input.mode,
          destinationPath: input.destinationPath,
          destinationName: input.destinationName,
        });
      }),
  );
  server.registerTool(
    'interchange_import_apply',
    {
      description:
        'Atomically apply a reviewed interchange plan. Round-trip plans require the original expected revision.',
      inputSchema: {
        planId: z.string().uuid(),
        expectedRevision: expectedRevision.optional(),
        confirm: z.literal(true),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ planId, expectedRevision: revision }) =>
      guarded(
        async () =>
          await workspace.applyInterchangePlan({
            clientId,
            planId,
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          }),
      ),
  );
  server.registerTool(
    'interchange_import_discard',
    {
      description:
        'Discard a client-owned reviewed interchange plan without applying it.',
      inputSchema: { planId: z.string().uuid() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ planId }) =>
      guarded(() => {
        workspace.discardInterchangePlan(clientId, planId);
        return { discarded: true };
      }),
  );

  server.registerTool(
    'timeline_diagnostics_submit',
    {
      description:
        'Submit a durable advisory timeline diagnostic job. It never mutates the project or blocks export.',
      inputSchema: {
        projectId,
        dialogueTrackIds: z.array(entityId).max(64).optional(),
        musicTrackIds: z.array(entityId).max(64).optional(),
        safeMargin: z.number().min(0).max(0.25).optional(),
        maxCaptionCharactersPerSecond: z.number().min(1).max(80).optional(),
        shortClipFrames: z.number().int().min(1).max(10_000).optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({
      projectId: id,
      dialogueTrackIds,
      musicTrackIds,
      safeMargin,
      maxCaptionCharactersPerSecond,
      shortClipFrames,
    }) =>
      guarded(() =>
        workspace.submitTimelineDiagnostics({
          projectId: id,
          clientId,
          options: {
            ...(dialogueTrackIds === undefined ? {} : { dialogueTrackIds }),
            ...(musicTrackIds === undefined ? {} : { musicTrackIds }),
            ...(safeMargin === undefined ? {} : { safeMargin }),
            ...(maxCaptionCharactersPerSecond === undefined
              ? {}
              : { maxCaptionCharactersPerSecond }),
            ...(shortClipFrames === undefined ? {} : { shortClipFrames }),
          },
        }),
      ),
  );

  server.registerTool(
    'render_submit',
    {
      description:
        'Submit a nonblocking export job using a validated built-in profile.',
      inputSchema: {
        projectId,
        profileId: z.string().min(1).max(100),
        outputName: z.string().min(1).max(128),
        maxAttempts: z.number().int().min(1).max(5).default(1),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ projectId: id, profileId, outputName, maxAttempts }) =>
      guarded(
        async () =>
          await workspace.submitExport({
            projectId: id,
            profileId,
            outputName,
            maxAttempts,
            clientId,
          }),
      ),
  );

  server.registerTool(
    'preview_submit',
    {
      description: 'Submit a nonblocking frame, range, or audio preview job.',
      inputSchema: {
        projectId,
        kind: z.enum(['frame', 'range', 'audio']),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ projectId: id, kind, start, end }) =>
      guarded(
        async () =>
          await workspace.submitPreview({
            projectId: id,
            clientId,
            kind,
            start,
            ...(end === undefined ? {} : { end }),
          }),
      ),
  );

  server.registerTool(
    'preview_inspect',
    {
      description: 'Create a cached waveform or contact sheet.',
      inputSchema: {
        projectId,
        kind: z.enum(['waveform', 'contact-sheet']),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().positive().optional(),
        frames: z
          .array(z.number().int().nonnegative())
          .min(1)
          .max(12)
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectId: id, kind, start, end, frames }) =>
      guarded(
        async () =>
          await workspace.directPreview({
            projectId: id,
            kind,
            ...(start === undefined ? {} : { start }),
            ...(end === undefined ? {} : { end }),
            ...(frames === undefined ? {} : { frames }),
          }),
      ),
  );

  server.registerTool(
    'job_get',
    {
      description:
        'Read an owned render/preview job and artifact resource URI.',
      inputSchema: { jobId: entityId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ jobId }, extra) => {
      return await guarded(async () => {
        const job = workspace.job(clientId, jobId);
        if (extra._meta?.progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: extra._meta.progressToken,
              progress: job.progress,
              total: 1,
              message: job.status,
            },
          });
        }
        return {
          ...job,
          artifactUri: `kdenlive://artifacts/${jobId}`,
        };
      });
    },
  );
  server.registerTool(
    'job_list',
    {
      description: 'List jobs owned by this client.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(() => workspace.jobs(clientId)),
  );
  server.registerTool(
    'job_cancel',
    {
      description: 'Cancel an owned queued or running job.',
      inputSchema: { jobId: entityId },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ jobId }) => guarded(() => workspace.cancelJob(clientId, jobId)),
  );
  server.registerTool(
    'job_verify',
    {
      description:
        'Verify a successful owned export and return structured diagnostics.',
      inputSchema: { jobId: entityId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ jobId }) =>
      guarded(async () => await workspace.verification(clientId, jobId)),
  );

  server.registerResource(
    'export-profiles',
    'kdenlive://profiles',
    {
      description: 'Validated built-in export profile catalog',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: 'kdenlive://profiles',
          mimeType: 'application/json',
          text: JSON.stringify(workspace.catalog()),
        },
      ],
    }),
  );
  server.registerResource(
    'editing-recipe-catalog',
    'kdenlive://recipes',
    {
      description: 'Versioned editing recipe catalog',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: 'kdenlive://recipes',
          mimeType: 'application/json',
          text: JSON.stringify(EDITING_RECIPES),
        },
      ],
    }),
  );
  server.registerResource(
    'editing-recipe',
    new ResourceTemplate('kdenlive://recipes/{recipeId}', { list: undefined }),
    {
      description: 'One versioned editing recipe',
      mimeType: 'application/json',
    },
    (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(recipe(String(variables.recipeId))),
        },
      ],
    }),
  );
  server.registerResource(
    'timeline-diagnostic-report',
    new ResourceTemplate('kdenlive://timeline-diagnostics/{jobId}', {
      list: undefined,
    }),
    {
      description: 'Owned advisory timeline diagnostic report',
      mimeType: 'application/json',
    },
    (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            workspace.timelineDiagnosticReport(
              clientId,
              String(variables.jobId),
            ),
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'interchange-plan',
    new ResourceTemplate('kdenlive://interchange/plans/{planId}', {
      list: undefined,
    }),
    {
      description: 'Client-owned reviewed interchange plan',
      mimeType: 'application/json',
    },
    (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            workspace.interchangePlan(clientId, String(variables.planId)),
          ),
        },
      ],
    }),
  );
  server.registerResource(
    'interchange-artifact',
    new ResourceTemplate('kdenlive://interchange/artifacts/{artifactId}', {
      list: undefined,
    }),
    {
      description: 'Owned bounded Kdenlive or OTIO export',
      mimeType: 'application/octet-stream',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/octet-stream',
          blob: (
            await workspace.readInterchangeArtifact(
              clientId,
              String(variables.artifactId),
            )
          ).toString('base64'),
        },
      ],
    }),
  );
  server.registerResource(
    'agent-instructions',
    'kdenlive://instructions',
    {
      description: 'Editing, revision, preview, and recovery rules',
      mimeType: 'text/markdown',
    },
    () => ({
      contents: [
        {
          uri: 'kdenlive://instructions',
          mimeType: 'text/markdown',
          text: AGENT_INSTRUCTIONS,
        },
      ],
    }),
  );
  server.registerResource(
    'runtime-capabilities',
    'kdenlive://capabilities',
    {
      description: 'Installed MLT and FFmpeg runtime capability snapshot',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'kdenlive://capabilities',
          mimeType: 'application/json',
          text: JSON.stringify(await workspace.capabilities()),
        },
      ],
    }),
  );
  server.registerResource(
    'project-summary',
    new ResourceTemplate('kdenlive://projects/{projectId}/summary', {
      list: undefined,
    }),
    {
      description: 'Compact current project summary',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const id = String(variables.projectId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(workspace.timeline(id, { limit: 100 })),
          },
        ],
      };
    },
  );
  server.registerResource(
    'job-diagnostic',
    new ResourceTemplate('kdenlive://diagnostics/{jobId}', {
      list: undefined,
    }),
    {
      description: 'Structured Melt failure diagnostic for an owned job',
      mimeType: 'application/json',
    },
    (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            workspace.diagnostic(clientId, String(variables.jobId)),
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'job-artifact',
    new ResourceTemplate('kdenlive://artifacts/{jobId}', { list: undefined }),
    {
      description: 'Owned bounded render or preview artifact',
      mimeType: 'application/octet-stream',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/octet-stream',
          blob: (
            await workspace.readArtifact(clientId, String(variables.jobId))
          ).toString('base64'),
        },
      ],
    }),
  );

  return server;
}
