# Session Filesystem Snapshots

## Status

Initial design. This describes a manual checkpoint and restore flow; it is not implemented yet.

## Goal

Allow a user to select an existing OpenCode session, save the current Modal VM root filesystem as an Image, and optionally terminate the VM. A later request for any session in the same workspace recreates the VM from that Image while mounting the existing persistent Volume.

This preserves both kinds of state:

- The filesystem snapshot preserves packages and tools installed outside `/persist`.
- The Volume preserves `/persist/project`, `opencode.db`, configuration, and other OpenCode state.

Snapshots belong to workspaces, not individual sessions. Every session in a workspace shares the same VM and Volume.

## API

Add a gateway-owned endpoint handled before normal OpenCode routing:

```http
POST /gateway/session/:sessionID/snapshot
Authorization: Basic ...
Content-Type: application/json

{
  "terminate": true,
  "ttlMs": null
}
```

`terminate` defaults to `false`. `ttlMs` defaults to Modal's 30-day retention; `null` retains the Image indefinitely.

Example response:

```json
{
  "sessionID": "ses_...",
  "workspaceID": "wrk_...",
  "sandboxID": "sb-...",
  "imageID": "im-...",
  "generation": 1,
  "terminated": true,
  "durationMs": 4200
}
```

The existing gateway password protects this endpoint. The caller supplies a session ID, but the gateway resolves and operates on its owning workspace.

## Snapshot Flow

1. Resolve the session to a workspace and its current sandbox.
2. Acquire a per-workspace lifecycle lock.
3. Require the workspace to be idle. The first version may return `409 Conflict` when OpenCode is processing a prompt or tool call.
4. Flush `/persist` so Volume state is durable.
5. Call `sandbox.snapshotFilesystem({ ttlMs })`.
6. Persist the returned Image ID and source sandbox generation in the gateway database.
7. If `terminate` is true, terminate the sandbox, mark its generation finished, and stop its event watcher.
8. Return the checkpoint details.

The database update must happen before termination. If snapshot creation or persistence fails, the current sandbox remains running and remains authoritative.

## Stored State

Add one current snapshot record per workspace:

```sql
CREATE TABLE workspace_snapshot (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL,
  source_sandbox_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_expires INTEGER
);
```

Replacing a snapshot is transactional: store the new Image ID first, then delete the superseded Modal Image. A failed deletion is logged for later cleanup and must not invalidate the new checkpoint.

## Restore Flow

When a routed request targets a workspace without a running sandbox:

1. Acquire the same per-workspace lifecycle lock.
2. Recheck whether another request already restored it.
3. Load the workspace's saved Image with `client.images.fromId(imageID)`.
4. Create sandbox generation `N + 1` from that Image.
5. Mount the same Volume subpath at `/persist`.
6. Run the normal OpenCode bootstrap and credential synchronization.
7. Register the new sandbox and reconnect the workspace event watcher.
8. Retry the original routed request against the new backend.

Concurrent requests share one restore operation. They must never create multiple active generations for the same workspace.

If the Image has expired or disappeared, restoration fails with an actionable error. The gateway must not silently fall back to the default image because that would discard installed root-filesystem state. A separate explicit reset operation can be added later.

## Lifecycle

The first version supports manual checkpointing and optional immediate termination. Once restore is reliable, `idleTimeoutMs` can terminate inactive VMs automatically. The saved workspace Image and Volume then provide the resume state.

Event watching must be generation-aware. A watcher for a terminated sandbox must stop, and restoration must start a watcher connected to the replacement sandbox.

## Logging

Log these lifecycle boundaries with workspace, sandbox, generation, Image ID, and elapsed time where available:

- Snapshot requested
- Volume flushed
- Filesystem snapshot created
- Snapshot recorded
- Sandbox terminated
- Restore started
- Replacement sandbox ready
- Snapshot or restore failed

Do not log credentials, connect tokens, or request authorization.

## Initial Scope

- One current snapshot per workspace
- Manual authenticated HTTP operation
- Optional termination after a successful snapshot
- Lazy restore on the next workspace-routed request
- Indefinite or explicit Modal TTL
- No memory snapshots
- No snapshot branching or user-visible history
- No agent tool or sandbox-to-gateway callback

## Open Questions

- How should the gateway determine that a workspace is idle before snapshotting?
- Should `terminate` default to `true` once restore has been proven reliable?
- Should superseded Images be deleted immediately or retained briefly for rollback?
- Which HTTP requests may wait for lazy restore, and what timeout should clients receive?
