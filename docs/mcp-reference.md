# MCP reference

All tools return a structured `{ "ok": true, "data": ... }` envelope or an
`isError` result with `{ "ok": false, "error": { "code", "message" } }`.
Every mutation requires `projectId` and `expectedRevision` and returns the new
revision, changed IDs, warnings, and an undo token.

## Project and media

| Tool                                               | Purpose                                               |
| -------------------------------------------------- | ----------------------------------------------------- |
| `project_create`, `project_open`, `project_get`    | Manage canonical project stores                       |
| `project_validate`                                 | Return deterministic diagnostics                      |
| `project_checkpoint`, `project_checkpoint_restore` | Save/restore named snapshots as revisions             |
| `project_undo`, `project_redo`                     | Client-scoped history                                 |
| `media_import`                                     | Import contained local paths in managed/external mode |
| `media_list`, `media_inspect`                      | Read assets and normalized probe data                 |

## Timeline

| Tool                                                                                | Purpose                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `timeline_query`                                                                    | Bounded filtered timeline inspection                     |
| `timeline_add_track`, `timeline_add_clips`                                          | Track creation and batched placement                     |
| `timeline_move_clips`, `timeline_remove_clips`, `timeline_split_clip`               | Structural gestures                                      |
| `timeline_trim_clip`, `timeline_slip_clip`, `timeline_set_speed`                    | Source/timing changes                                    |
| `timeline_ripple_delete`                                                            | Normalized batched ripple deletion                       |
| `clip_set_properties`, `clip_set_keyframes`, `clip_set_effects`                     | Properties and animation                                 |
| `transition_edit`                                                                   | Add/update/remove transitions                            |
| `text_edit`, `caption_edit`, `marker_edit`                                          | Add/update/remove timed creative entities                |
| `caption_export`                                                                    | Write SRT or WebVTT under project artifacts              |
| `interchange_export`                                                                | Write editable Kdenlive 26.04.x or OTIO 0.18.1 artifacts |
| `interchange_import_plan`, `interchange_import_apply`, `interchange_import_discard` | Reviewed atomic interchange imports                      |
| `timeline_diagnostics_submit`                                                       | Submit advisory durable timeline diagnostics             |

## Rendering and jobs

| Tool                                | Purpose                               |
| ----------------------------------- | ------------------------------------- |
| `preview_submit`                    | Durable frame/range/audio preview job |
| `preview_inspect`                   | Cached waveform or contact sheet      |
| `render_submit`                     | Durable validated-profile export job  |
| `job_get`, `job_list`, `job_cancel` | Client-owned job lifecycle            |
| `job_verify`                        | Structured output verification        |

Successful job artifacts are available at `kdenlive://artifacts/{jobId}` and are
limited to 32 MiB per resource read. Larger export paths remain in the job result.

## Resources

| URI                                             | Content                            |
| ----------------------------------------------- | ---------------------------------- |
| `kdenlive://instructions`                       | Agent frame/revision/editing rules |
| `kdenlive://profiles`                           | Validated export profile catalog   |
| `kdenlive://capabilities`                       | Installed runtime snapshot         |
| `kdenlive://projects/{projectId}/summary`       | Compact project/timeline summary   |
| `kdenlive://artifacts/{jobId}`                  | Owned bounded artifact             |
| `kdenlive://interchange/artifacts/{artifactId}` | Owned Kdenlive/OTIO artifact       |
| `kdenlive://interchange/plans/{planId}`         | Reviewed import plan               |
| `kdenlive://recipes`                            | Versioned recipe catalog           |
| `kdenlive://recipes/{recipeId}`                 | Individual editing recipe          |
| `kdenlive://timeline-diagnostics/{jobId}`       | Advisory diagnostic report         |

## Error codes

`REVISION_CONFLICT`, `PROJECT_INVALID`, `TIMELINE_EDIT_INVALID`,
`INVALID_ARGUMENTS`, `MELT_BUSY`, `PATH_OUTSIDE_ROOTS`, `JOB_FORBIDDEN`, `NOT_FOUND`,
`OPERATION_FAILED`, and `INTERNAL_ERROR` are stable public codes. Details remain
bounded and must not be parsed as a second API.

`MELT_BUSY` is retryable and is returned for Melt-backed previews while an
export is queued or running. Export jobs remain FIFO and execute one at a time.

The registered Zod schemas exposed by MCP tool discovery are authoritative for
individual fields and limits.

## Mutation examples

Caption frames use the project frame rate. Adding a caption requires its complete
style; updating one uses an `id` and a partial `patch`:

```json
{
  "projectId": "00000000-0000-0000-0000-000000000000",
  "expectedRevision": 3,
  "action": "add",
  "items": [
    {
      "start": 0,
      "end": 90,
      "text": "Hello",
      "style": { "preset": "default", "position": "bottom" }
    }
  ]
}
```

Clip properties are nested under `properties`. All nested property groups are
partial, so an audio-only loudness adjustment does not require transform data:

```json
{
  "projectId": "00000000-0000-0000-0000-000000000000",
  "expectedRevision": 4,
  "updates": [
    {
      "clipId": "00000000-0000-0000-0000-000000000001",
      "properties": { "audio": { "volume": 2.5 } }
    }
  ]
}
```

Semantically invalid timeline edits return `TIMELINE_EDIT_INVALID`. Its bounded
`error.details.diagnostics` array contains diagnostic codes, paths, messages,
and related entity IDs when available.
