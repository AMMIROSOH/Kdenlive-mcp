# First project tutorial

1. Install the server and make `kdenlive-mcp --doctor` pass.
2. Configure an MCP client with a dedicated absolute video workspace and stable
   `--client-id`.
3. Ask the client to create a project at a child directory of that workspace.
4. Import a small local clip in managed mode and inspect the returned asset.
5. Query the empty timeline, append the clip with linked A/V, and retain the new revision.
6. Add a title or caption in project frames.
7. Submit a frame or short range preview and poll `job_get` until it succeeds.
8. Read the bounded artifact resource and review it.
9. Create a checkpoint, make further edits, and use client-scoped undo if needed.
10. Submit an FFV1 mezzanine export, then call `job_verify` before delivery.

The server resource `kdenlive://instructions` contains the concise operating rules
for agents. The acceptance workflow in `apps/mcp-server/src/acceptance-cli.ts`
implements these steps with synthetic media and is run by `pnpm mcp:acceptance`.
