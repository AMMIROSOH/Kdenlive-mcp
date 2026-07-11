export const AGENT_INSTRUCTIONS = `# Kdenlive MCP operating rules

1. Open or create a project, then inspect project_get and timeline_query before editing.
2. Every mutation requires expectedRevision. If it conflicts, inspect again; never guess a revision.
3. Public timing is integer project frames. Use the project's rational FPS for conversion.
4. Keep stable entity IDs from tool results. Do not infer IDs from names or array positions.
5. Linked A/V clips move and split together unless includeLinked is explicitly false.
6. Batch related edits into one tool call where the tool accepts arrays. Each successful mutation returns an undo token and one new revision.
7. Use project_checkpoint before a risky multi-step workflow. Undo and redo are scoped to this MCP client identity.
8. Submit previews before expensive exports. Poll job_get; use job_cancel when work is no longer needed.
9. Artifacts are available only after a job succeeds and remain subject to ownership and size limits.
10. Treat warnings as fidelity decisions. Inspect transition source handles, unavailable services/codecs, and verification diagnostics before delivery.
11. A MELT_EXECUTION_FAILED result blocks render QA and export. Do not retry through another Melt preview kind, use cached or source media as substitute QA, switch editors, or claim readiness. Report the failure category and diagnostic resource, then stop dependent work.
`;
