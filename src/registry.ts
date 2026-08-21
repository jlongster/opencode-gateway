export * as GatewayRegistry from "./registry.js";

import { Workspace } from "@opencode-ai/schema/workspace";
import { Context, Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { GatewayDatabase } from "./database.js";

export const SandboxStatus = Schema.Literals([
  "creating",
  "running",
  "missing",
  "finished",
  "failed",
]);
export type SandboxStatus = typeof SandboxStatus.Type;
const Tags = Schema.Record(Schema.String, Schema.String);
const decodeTags = Schema.decodeUnknownSync(Schema.fromJsonString(Tags));

export interface WorkspaceInfo {
  readonly id: Workspace.ID;
  readonly volumeSubpath: string;
  readonly directory: string;
  readonly time: { readonly created: number; readonly updated: number };
}

export interface SandboxInfo {
  readonly id: string;
  readonly workspaceID: Workspace.ID;
  readonly generation: number;
  readonly status: SandboxStatus;
  readonly endpoint?: string;
  readonly time: {
    readonly created: number;
    readonly expires?: number;
    readonly connected?: number;
    readonly finished?: number;
  };
  readonly error?: string;
}

export interface SessionBinding {
  readonly id: string;
  readonly workspaceID: Workspace.ID;
  readonly projectID: string;
  readonly parentID?: string;
  readonly time: { readonly created: number; readonly updated: number };
}

export interface QuarantinedSandbox {
  readonly sandboxID: string;
  readonly reason: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly timeObserved: number;
}

export interface ResourceOwner {
  readonly kind: string;
  readonly id: string;
  readonly workspaceID: Workspace.ID;
  readonly sandboxID: string;
}

export class WorkspaceNotFoundError extends Schema.TaggedErrorClass<WorkspaceNotFoundError>()(
  "GatewayRegistry.WorkspaceNotFoundError",
  { workspaceID: Workspace.ID },
) {}

export class OwnershipConflictError extends Schema.TaggedErrorClass<OwnershipConflictError>()(
  "GatewayRegistry.OwnershipConflictError",
  {
    resource: Schema.String,
    id: Schema.String,
    expectedWorkspaceID: Workspace.ID,
    actualWorkspaceID: Workspace.ID,
  },
) {}

export interface Interface {
  readonly installationID: Effect.Effect<string>;
  readonly createWorkspace: (input: {
    readonly directory: string;
    readonly volumeSubpathPrefix?: string;
  }) => Effect.Effect<WorkspaceInfo>;
  readonly getWorkspace: (
    workspaceID: Workspace.ID,
  ) => Effect.Effect<WorkspaceInfo | undefined>;
  readonly listWorkspaces: Effect.Effect<WorkspaceInfo[]>;
  readonly removeWorkspace: (workspaceID: Workspace.ID) => Effect.Effect<void>;
  readonly registerSandbox: (input: {
    readonly id: string;
    readonly workspaceID: Workspace.ID;
    readonly generation: number;
    readonly status: SandboxStatus;
    readonly endpoint?: string;
    readonly timeCreated: number;
    readonly timeExpires?: number;
  }) => Effect.Effect<
    SandboxInfo,
    WorkspaceNotFoundError | OwnershipConflictError
  >;
  readonly listSandboxes: Effect.Effect<SandboxInfo[]>;
  readonly currentSandbox: (
    workspaceID: Workspace.ID,
  ) => Effect.Effect<SandboxInfo | undefined>;
  readonly markMissingSandboxes: (
    activeIDs: ReadonlySet<string>,
    time: number,
  ) => Effect.Effect<void>;
  readonly registerProject: (input: {
    readonly workspaceID: Workspace.ID;
    readonly projectID: string;
    readonly directory: string;
    readonly canonical?: string;
    readonly time: number;
  }) => Effect.Effect<void, WorkspaceNotFoundError>;
  readonly registerSession: (input: {
    readonly id: string;
    readonly workspaceID: Workspace.ID;
    readonly projectID: string;
    readonly parentID?: string;
    readonly timeCreated: number;
    readonly timeUpdated: number;
  }) => Effect.Effect<
    SessionBinding,
    WorkspaceNotFoundError | OwnershipConflictError
  >;
  readonly findSession: (
    sessionID: string,
  ) => Effect.Effect<SessionBinding | undefined>;
  readonly listSessions: Effect.Effect<SessionBinding[]>;
  readonly removeSession: (sessionID: string) => Effect.Effect<void>;
  readonly findResource: (
    kind: string,
    id: string,
  ) => Effect.Effect<ResourceOwner | undefined>;
  readonly registerResource: (
    input: ResourceOwner,
  ) => Effect.Effect<void, OwnershipConflictError>;
  readonly removeResource: (kind: string, id: string) => Effect.Effect<void>;
  readonly quarantine: (input: {
    readonly sandboxID: string;
    readonly reason: string;
    readonly tags: Readonly<Record<string, string>>;
    readonly time: number;
  }) => Effect.Effect<void>;
  readonly listQuarantined: Effect.Effect<QuarantinedSandbox[]>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Registry",
) {}

type WorkspaceRow = {
  id: string;
  volume_subpath: string;
  directory: string;
  time_created: number;
  time_updated: number;
};

type SandboxRow = {
  id: string;
  workspace_id: string;
  generation: number;
  status: SandboxStatus;
  endpoint: string | null;
  time_created: number;
  time_expires: number | null;
  time_connected: number | null;
  time_finished: number | null;
  error: string | null;
};

type SessionRow = {
  id: string;
  workspace_id: string;
  upstream_project_id: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
};

function workspace(row: WorkspaceRow): WorkspaceInfo {
  return {
    id: Workspace.ID.make(row.id),
    volumeSubpath: row.volume_subpath,
    directory: row.directory,
    time: { created: row.time_created, updated: row.time_updated },
  };
}

function sandbox(row: SandboxRow): SandboxInfo {
  return {
    id: row.id,
    workspaceID: Workspace.ID.make(row.workspace_id),
    generation: row.generation,
    status: row.status,
    endpoint: row.endpoint ?? undefined,
    time: {
      created: row.time_created,
      expires: row.time_expires ?? undefined,
      connected: row.time_connected ?? undefined,
      finished: row.time_finished ?? undefined,
    },
    error: row.error ?? undefined,
  };
}

function session(row: SessionRow): SessionBinding {
  return {
    id: row.id,
    workspaceID: Workspace.ID.make(row.workspace_id),
    projectID: row.upstream_project_id,
    parentID: row.parent_id ?? undefined,
    time: { created: row.time_created, updated: row.time_updated },
  };
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* GatewayDatabase.Service;
    const sql = database.sql;

    const getWorkspace = Effect.fn("GatewayRegistry.getWorkspace")(function* (
      workspaceID: Workspace.ID,
    ) {
      const rows =
        yield* sql<WorkspaceRow>`SELECT * FROM workspace WHERE id = ${workspaceID}`.pipe(
          Effect.orDie,
        );
      return rows[0] ? workspace(rows[0]) : undefined;
    });

    const requireWorkspace = Effect.fnUntraced(function* (
      workspaceID: Workspace.ID,
    ) {
      const result = yield* getWorkspace(workspaceID);
      if (!result) return yield* new WorkspaceNotFoundError({ workspaceID });
      return result;
    });

    const installationID = sql<{
      installation_id: string;
    }>`SELECT installation_id FROM gateway WHERE singleton = 1`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => {
        if (rows[0]) return Effect.succeed(rows[0].installation_id);
        const id = `gw_${randomUUID()}`;
        return sql`INSERT OR IGNORE INTO gateway (singleton, installation_id, time_created) VALUES (1, ${id}, ${Date.now()})`.pipe(
          Effect.orDie,
          Effect.andThen(
            sql<{
              installation_id: string;
            }>`SELECT installation_id FROM gateway WHERE singleton = 1`.pipe(
              Effect.orDie,
              Effect.map((created) => created[0]?.installation_id ?? id),
            ),
          ),
        );
      }),
    );

    const createWorkspace = Effect.fn("GatewayRegistry.createWorkspace")(
      function* (input: {
        readonly directory: string;
        readonly volumeSubpathPrefix?: string;
      }) {
        const id = Workspace.ID.create();
        const prefix = (input.volumeSubpathPrefix ?? "/workspaces").replace(
          /\/+$/,
          "",
        );
        const time = Date.now();
        yield* sql`
        INSERT INTO workspace (id, volume_subpath, directory, time_created, time_updated)
        VALUES (${id}, ${`${prefix}/${id}`}, ${input.directory}, ${time}, ${time})
      `.pipe(Effect.orDie);
        const created = yield* getWorkspace(id);
        if (!created)
          return yield* Effect.die(
            new Error(`Workspace was not created: ${id}`),
          );
        return created;
      },
    );

    const listWorkspaces =
      sql<WorkspaceRow>`SELECT * FROM workspace ORDER BY time_created, id`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(workspace)),
      );

    const removeWorkspace = Effect.fn("GatewayRegistry.removeWorkspace")(
      (workspaceID: Workspace.ID) =>
        sql`DELETE FROM workspace WHERE id = ${workspaceID}`.pipe(
          Effect.orDie,
          Effect.asVoid,
        ),
    );

    const registerSandbox = Effect.fn("GatewayRegistry.registerSandbox")(
      function* (input: {
        readonly id: string;
        readonly workspaceID: Workspace.ID;
        readonly generation: number;
        readonly status: SandboxStatus;
        readonly endpoint?: string;
        readonly timeCreated: number;
        readonly timeExpires?: number;
      }) {
        yield* requireWorkspace(input.workspaceID);
        const existing = yield* sql<{
          workspace_id: string;
        }>`SELECT workspace_id FROM sandbox WHERE id = ${input.id}`.pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0]),
        );
        if (existing && existing.workspace_id !== input.workspaceID)
          return yield* new OwnershipConflictError({
            resource: "sandbox",
            id: input.id,
            expectedWorkspaceID: Workspace.ID.make(existing.workspace_id),
            actualWorkspaceID: input.workspaceID,
          });
        const generation = yield* sql<{ id: string }>`
        SELECT id FROM sandbox
        WHERE workspace_id = ${input.workspaceID} AND generation = ${input.generation}
      `.pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0]),
        );
        if (generation && generation.id !== input.id)
          return yield* new OwnershipConflictError({
            resource: "sandbox generation",
            id: input.id,
            expectedWorkspaceID: input.workspaceID,
            actualWorkspaceID: input.workspaceID,
          });
        yield* sql`
        INSERT INTO sandbox (
          id, workspace_id, generation, status, endpoint, time_created, time_expires
        ) VALUES (
          ${input.id}, ${input.workspaceID}, ${input.generation}, ${input.status}, ${input.endpoint ?? null},
          ${input.timeCreated}, ${input.timeExpires ?? null}
        )
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          endpoint = excluded.endpoint,
          time_expires = excluded.time_expires,
          error = NULL,
          time_finished = NULL
      `.pipe(Effect.orDie);
        const rows =
          yield* sql<SandboxRow>`SELECT * FROM sandbox WHERE id = ${input.id}`.pipe(
            Effect.orDie,
          );
        const result = rows[0];
        if (!result)
          return yield* Effect.die(
            new Error(`Sandbox was not registered: ${input.id}`),
          );
        return sandbox(result);
      },
    );

    const listSandboxes =
      sql<SandboxRow>`SELECT * FROM sandbox ORDER BY time_created, id`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(sandbox)),
      );

    const currentSandbox = Effect.fn("GatewayRegistry.currentSandbox")(
      function* (workspaceID: Workspace.ID) {
        const rows = yield* sql<SandboxRow>`
        SELECT * FROM sandbox
        WHERE workspace_id = ${workspaceID} AND status = 'running'
        ORDER BY generation DESC
        LIMIT 1
      `.pipe(Effect.orDie);
        return rows[0] ? sandbox(rows[0]) : undefined;
      },
    );

    const markMissingSandboxes = Effect.fn(
      "GatewayRegistry.markMissingSandboxes",
    )(function* (activeIDs: ReadonlySet<string>, time: number) {
      const rows = yield* sql<{
        id: string;
      }>`SELECT id FROM sandbox WHERE status IN ('creating', 'running')`.pipe(
        Effect.orDie,
      );
      yield* Effect.forEach(
        rows.filter((row) => !activeIDs.has(row.id)),
        (row) =>
          sql`UPDATE sandbox SET status = 'missing', time_finished = ${time} WHERE id = ${row.id}`.pipe(
            Effect.orDie,
          ),
        { discard: true },
      );
    });

    const registerProject = Effect.fn("GatewayRegistry.registerProject")(
      function* (input: {
        readonly workspaceID: Workspace.ID;
        readonly projectID: string;
        readonly directory: string;
        readonly canonical?: string;
        readonly time: number;
      }) {
        yield* requireWorkspace(input.workspaceID);
        yield* sql`
        INSERT INTO project_binding (workspace_id, upstream_project_id, directory, canonical, time_updated)
        VALUES (${input.workspaceID}, ${input.projectID}, ${input.directory}, ${input.canonical ?? null}, ${input.time})
        ON CONFLICT(workspace_id) DO UPDATE SET
          upstream_project_id = excluded.upstream_project_id,
          directory = excluded.directory,
          canonical = excluded.canonical,
          time_updated = excluded.time_updated
      `.pipe(Effect.orDie);
      },
    );

    const registerSession = Effect.fn("GatewayRegistry.registerSession")(
      function* (input: {
        readonly id: string;
        readonly workspaceID: Workspace.ID;
        readonly projectID: string;
        readonly parentID?: string;
        readonly timeCreated: number;
        readonly timeUpdated: number;
      }) {
        yield* requireWorkspace(input.workspaceID);
        const existing = yield* sql<{
          workspace_id: string;
        }>`SELECT workspace_id FROM session_binding WHERE id = ${input.id}`.pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0]),
        );
        if (existing && existing.workspace_id !== input.workspaceID)
          return yield* new OwnershipConflictError({
            resource: "session",
            id: input.id,
            expectedWorkspaceID: Workspace.ID.make(existing.workspace_id),
            actualWorkspaceID: input.workspaceID,
          });
        yield* sql`
        INSERT INTO session_binding (
          id, workspace_id, upstream_project_id, parent_id, time_created, time_updated
        ) VALUES (
          ${input.id}, ${input.workspaceID}, ${input.projectID}, ${input.parentID ?? null},
          ${input.timeCreated}, ${input.timeUpdated}
        )
        ON CONFLICT(id) DO UPDATE SET
          upstream_project_id = excluded.upstream_project_id,
          parent_id = excluded.parent_id,
          time_updated = excluded.time_updated
      `.pipe(Effect.orDie);
        const rows =
          yield* sql<SessionRow>`SELECT * FROM session_binding WHERE id = ${input.id}`.pipe(
            Effect.orDie,
          );
        const result = rows[0];
        if (!result)
          return yield* Effect.die(
            new Error(`Session was not registered: ${input.id}`),
          );
        return session(result);
      },
    );

    const findSession = Effect.fn("GatewayRegistry.findSession")(function* (
      sessionID: string,
    ) {
      const rows =
        yield* sql<SessionRow>`SELECT * FROM session_binding WHERE id = ${sessionID}`.pipe(
          Effect.orDie,
        );
      return rows[0] ? session(rows[0]) : undefined;
    });

    const listSessions =
      sql<SessionRow>`SELECT * FROM session_binding ORDER BY time_updated DESC, id`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(session)),
      );

    const removeSession = Effect.fn("GatewayRegistry.removeSession")(
      (sessionID: string) =>
        sql`DELETE FROM session_binding WHERE id = ${sessionID}`.pipe(
          Effect.orDie,
          Effect.asVoid,
        ),
    );

    const findResource = Effect.fn("GatewayRegistry.findResource")(function* (
      kind: string,
      id: string,
    ) {
      const rows = yield* sql<{
        kind: string;
        id: string;
        workspace_id: string;
        sandbox_id: string;
      }>`SELECT kind, id, workspace_id, sandbox_id FROM resource_owner WHERE kind = ${kind} AND id = ${id}`.pipe(
        Effect.orDie,
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        kind: row.kind,
        id: row.id,
        workspaceID: Workspace.ID.make(row.workspace_id),
        sandboxID: row.sandbox_id,
      };
    });

    const registerResource = Effect.fn("GatewayRegistry.registerResource")(
      function* (input: ResourceOwner) {
        const existing = yield* sql<{ workspace_id: string }>`
        SELECT workspace_id FROM resource_owner WHERE kind = ${input.kind} AND id = ${input.id}
      `.pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0]),
        );
        if (existing && existing.workspace_id !== input.workspaceID)
          return yield* new OwnershipConflictError({
            resource: input.kind,
            id: input.id,
            expectedWorkspaceID: Workspace.ID.make(existing.workspace_id),
            actualWorkspaceID: input.workspaceID,
          });
        yield* sql`
        INSERT INTO resource_owner (kind, id, workspace_id, sandbox_id, time_created)
        VALUES (${input.kind}, ${input.id}, ${input.workspaceID}, ${input.sandboxID}, ${Date.now()})
        ON CONFLICT(kind, id) DO UPDATE SET
          sandbox_id = excluded.sandbox_id
      `.pipe(Effect.orDie);
        return undefined;
      },
    );

    const removeResource = Effect.fn("GatewayRegistry.removeResource")(
      (kind: string, id: string) =>
        sql`DELETE FROM resource_owner WHERE kind = ${kind} AND id = ${id}`.pipe(
          Effect.orDie,
          Effect.asVoid,
        ),
    );

    const quarantine = Effect.fn("GatewayRegistry.quarantine")(
      (input: {
        readonly sandboxID: string;
        readonly reason: string;
        readonly tags: Readonly<Record<string, string>>;
        readonly time: number;
      }) =>
        sql`
        INSERT INTO sandbox_quarantine (sandbox_id, reason, tags, time_observed)
        VALUES (${input.sandboxID}, ${input.reason}, ${JSON.stringify(input.tags)}, ${input.time})
        ON CONFLICT(sandbox_id) DO UPDATE SET
          reason = excluded.reason,
          tags = excluded.tags,
          time_observed = excluded.time_observed
      `.pipe(Effect.orDie, Effect.asVoid),
    );

    const listQuarantined = sql<{
      sandbox_id: string;
      reason: string;
      tags: string;
      time_observed: number;
    }>`SELECT * FROM sandbox_quarantine ORDER BY time_observed DESC, sandbox_id`.pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.map((row) => ({
          sandboxID: row.sandbox_id,
          reason: row.reason,
          tags: decodeTags(row.tags),
          timeObserved: row.time_observed,
        })),
      ),
    );

    return Service.of({
      installationID,
      createWorkspace,
      getWorkspace,
      listWorkspaces,
      removeWorkspace,
      registerSandbox,
      listSandboxes,
      currentSandbox,
      markMissingSandboxes,
      registerProject,
      registerSession,
      findSession,
      listSessions,
      removeSession,
      findResource,
      registerResource,
      removeResource,
      quarantine,
      listQuarantined,
    });
  }),
);
