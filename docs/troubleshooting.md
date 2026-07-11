# Troubleshooting

Start with `kdenlive-mcp --doctor`.

## Executable not discovered

Install Kdenlive normally, add standalone executables to `PATH`, set
`KDENLIVE_ROOT`, or set `MELT_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH` to an
exact executable or a containing directory. On Windows,
`KDENLIVE_ROOT=C:\Program Files\Kdenlive` is typical.

## MLT service missing

Minimal MLT packages may omit Qt or avformat modules. Install a complete Kdenlive
package. `qtext` is required for text/captions; `qtblend` and `mix` are required
for video/audio composition.

## MCP client shows no tools

Run the configured command manually with `--version` and `--doctor`. Verify that
the command and allowed root are absolute, stdout is not redirected, JSON/TOML is
valid, and the client was restarted after configuration.

## Revision conflict

Another edit committed first. Call `project_get` or `timeline_query`, inspect the
new state, and retry with the returned revision. Do not increment revisions by guess.

## Render fails

`project_validate` only checks project structure; it does not invoke Melt and is
not render QA. Likewise, an audio preview, cached artifact, or alternate frame
preview does not prove that contact-sheet or export rendering is healthy.

Call `job_get`, inspect its bounded log path and `diagnosticUri`, run `--doctor`, and try the FFV1
mezzanine profile to separate timeline problems from delivery-codec availability.
On Windows, Melt calls are serialized and isolated from host Qt/MLT environment
variables. Native crashes block the workflow rather than falling back to another
renderer. Keep the generated diagnostic and acceptance report when filing a bug.

## HTTP rejected

HTTP accepts only loopback Host/Origin values and a generated bearer token. It is
not a remote service. Delete the token file only when the server is stopped; the
next start creates a new token and invalidates old client configuration.
