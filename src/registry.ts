export * as GatewayRegistry from "./registry.js";

import { Workspace } from "@opencode-ai/schema/workspace";
import { Session } from "@opencode-ai/schema/session";
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
  readonly info?: Session.Info;
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

export const ImageNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface GatewayImage {
  readonly name: string;
  readonly kind: "default" | "snapshot";
  readonly imageID?: string;
  readonly sourceWorkspaceID?: Workspace.ID;
  readonly sourceSandboxID?: string;
  readonly sourceGeneration?: number;
  readonly timeCreated: number;
}

export interface WorkspaceImage {
  readonly workspaceID: Workspace.ID;
  readonly image: GatewayImage;
  readonly timeUpdated: number;
}

export const ToolCallStatus = Schema.Literals([
  "requested",
  "running",
  "succeeded",
  "failed",
]);
export type ToolCallStatus = typeof ToolCallStatus.Type;

export interface GatewayToolCall {
  readonly sandboxID: string;
  readonly toolCallID: string;
  readonly workspaceID: Workspace.ID;
  readonly sessionID: string;
  readonly assistantMessageID: string;
  readonly tool: string;
  readonly input: unknown;
  readonly status: ToolCallStatus;
  readonly result?: unknown;
  readonly time: { readonly created: number; readonly updated: number };
}

export interface SnapshotImageInput {
  readonly name: string;
  readonly imageID: string;
  readonly sourceWorkspaceID: Workspace.ID;
  readonly sourceSandboxID: string;
  readonly sourceGeneration: number;
  readonly timeCreated: number;
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

export class InvalidImageNameError extends Schema.TaggedErrorClass<InvalidImageNameError>()(
  "GatewayRegistry.InvalidImageNameError",
  { name: Schema.String },
) {}

export class ImageNotFoundError extends Schema.TaggedErrorClass<ImageNotFoundError>()(
  "GatewayRegistry.ImageNotFoundError",
  { name: Schema.String },
) {}

export class ImageNameConflictError extends Schema.TaggedErrorClass<ImageNameConflictError>()(
  "GatewayRegistry.ImageNameConflictError",
  { name: Schema.String },
) {}

export interface Interface {
  readonly installationID: Effect.Effect<string>;
  readonly createWorkspace: (input: {
    readonly directory: string;
    readonly volumeSubpathPrefix?: string;
    readonly imageName?: string;
  }) => Effect.Effect<WorkspaceInfo, ImageNotFoundError>;
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
  readonly finishSandbox: (
    sandboxID: string,
    status: "missing" | "finished" | "failed",
    time: number,
    error?: string,
  ) => Effect.Effect<void>;
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
    readonly info?: Session.Info;
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
  readonly listImages: Effect.Effect<GatewayImage[]>;
  readonly findImage: (name: string) => Effect.Effect<GatewayImage | undefined>;
  readonly getWorkspaceImage: (
    workspaceID: Workspace.ID,
  ) => Effect.Effect<WorkspaceImage | undefined>;
  readonly createSnapshotImage: (
    input: SnapshotImageInput,
  ) => Effect.Effect<
    GatewayImage,
    InvalidImageNameError | ImageNameConflictError | WorkspaceNotFoundError
  >;
  readonly nextSandboxGeneration: (
    workspaceID: Workspace.ID,
  ) => Effect.Effect<number, WorkspaceNotFoundError>;
  readonly recordToolInput: (input: {
    readonly sandboxID: string;
    readonly workspaceID: Workspace.ID;
    readonly sessionID: string;
    readonly assistantMessageID: string;
    readonly toolCallID: string;
    readonly tool: string;
    readonly time: number;
  }) => Effect.Effect<GatewayToolCall>;
  readonly correlateToolCall: (input: {
    readonly sandboxID: string;
    readonly toolCallID: string;
    readonly input: unknown;
    readonly time: number;
  }) => Effect.Effect<GatewayToolCall | undefined>;
  readonly findToolCall: (
    sandboxID: string,
    toolCallID: string,
  ) => Effect.Effect<GatewayToolCall | undefined>;
  readonly claimToolCall: (
    sandboxID: string,
    toolCallID: string,
    time: number,
  ) => Effect.Effect<GatewayToolCall | undefined>;
  readonly succeedToolCall: (input: {
    readonly sandboxID: string;
    readonly toolCallID: string;
    readonly result: unknown;
    readonly time: number;
    readonly image?: SnapshotImageInput;
  }) => Effect.Effect<
    GatewayToolCall | undefined,
    InvalidImageNameError | ImageNameConflictError | WorkspaceNotFoundError
  >;
  readonly failToolCall: (input: {
    readonly sandboxID: string;
    readonly toolCallID: string;
    readonly error: unknown;
    readonly time: number;
  }) => Effect.Effect<GatewayToolCall | undefined>;
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
  info: string | null;
};

type ImageRow = {
  name: string;
  kind: "default" | "snapshot";
  image_id: string | null;
  source_workspace_id: string | null;
  source_sandbox_id: string | null;
  source_generation: number | null;
  time_created: number;
};

type ToolCallRow = {
  sandbox_id: string;
  tool_call_id: string;
  workspace_id: string;
  session_id: string;
  assistant_message_id: string;
  tool: string;
  input: string;
  status: ToolCallStatus;
  result: string | null;
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
    info: row.info
      ? Schema.decodeUnknownSync(Session.Info)(JSON.parse(row.info))
      : undefined,
  };
}

function image(row: ImageRow): GatewayImage {
  return {
    name: row.name,
    kind: row.kind,
    imageID: row.image_id ?? undefined,
    sourceWorkspaceID: row.source_workspace_id
      ? Workspace.ID.make(row.source_workspace_id)
      : undefined,
    sourceSandboxID: row.source_sandbox_id ?? undefined,
    sourceGeneration: row.source_generation ?? undefined,
    timeCreated: row.time_created,
  };
}

function toolCall(row: ToolCallRow): GatewayToolCall {
  return {
    sandboxID: row.sandbox_id,
    toolCallID: row.tool_call_id,
    workspaceID: Workspace.ID.make(row.workspace_id),
    sessionID: row.session_id,
    assistantMessageID: row.assistant_message_id,
    tool: row.tool,
    input: JSON.parse(row.input),
    status: row.status,
    result: row.result === null ? undefined : JSON.parse(row.result),
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

    const findImage = Effect.fn("GatewayRegistry.findImage")(function* (
      name: string,
    ) {
      const rows = yield* sql<ImageRow>`
        SELECT * FROM gateway_image WHERE name = ${name}
      `.pipe(Effect.orDie);
      return rows[0] ? image(rows[0]) : undefined;
    });

    const insertSnapshotImage = Effect.fnUntraced(function* (
      input: SnapshotImageInput,
    ) {
      if (!ImageNamePattern.test(input.name))
        return yield* new InvalidImageNameError({ name: input.name });
      yield* requireWorkspace(input.sourceWorkspaceID);
      if (yield* findImage(input.name))
        return yield* new ImageNameConflictError({ name: input.name });
      yield* sql`
        INSERT INTO gateway_image (
          name, kind, image_id, source_workspace_id, source_sandbox_id,
          source_generation, time_created
        ) VALUES (
          ${input.name}, 'snapshot', ${input.imageID}, ${input.sourceWorkspaceID},
          ${input.sourceSandboxID}, ${input.sourceGeneration}, ${input.timeCreated}
        )
      `.pipe(Effect.orDie);
      yield* sql`
        UPDATE workspace_image
        SET image_name = ${input.name}, time_updated = ${input.timeCreated}
        WHERE workspace_id = ${input.sourceWorkspaceID}
      `.pipe(Effect.orDie);
      const created = yield* findImage(input.name);
      if (!created)
        return yield* Effect.die(
          new Error(`Image was not created: ${input.name}`),
        );
      return created;
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
        readonly imageName?: string;
      }) {
        const id = Workspace.ID.create();
        const prefix = (input.volumeSubpathPrefix ?? "/workspaces").replace(
          /\/+$/,
          "",
        );
        const time = Date.now();
        const imageName = input.imageName ?? "default";
        if (!(yield* findImage(imageName)))
          return yield* new ImageNotFoundError({ name: imageName });
        yield* Effect.gen(function* () {
          yield* sql`
            INSERT INTO workspace (id, volume_subpath, directory, time_created, time_updated)
            VALUES (${id}, ${`${prefix}/${id}`}, ${input.directory}, ${time}, ${time})
          `;
          yield* sql`
            INSERT INTO workspace_image (workspace_id, image_name, time_updated)
            VALUES (${id}, ${imageName}, ${time})
          `;
        }).pipe(sql.withTransaction, Effect.orDie);
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

    const finishSandbox = Effect.fn("GatewayRegistry.finishSandbox")(
      (
        sandboxID: string,
        status: "missing" | "finished" | "failed",
        time: number,
        error?: string,
      ) =>
        sql`
          UPDATE sandbox
          SET status = ${status}, time_finished = ${time}, error = ${error ?? null}
          WHERE id = ${sandboxID}
        `.pipe(Effect.orDie, Effect.asVoid),
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
        readonly info?: Session.Info;
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
          id, workspace_id, upstream_project_id, parent_id, time_created, time_updated, info
        ) VALUES (
          ${input.id}, ${input.workspaceID}, ${input.projectID}, ${input.parentID ?? null},
          ${input.timeCreated}, ${input.timeUpdated}, ${input.info ? JSON.stringify(Schema.encodeSync(Session.Info)(input.info)) : null}
        )
        ON CONFLICT(id) DO UPDATE SET
          upstream_project_id = excluded.upstream_project_id,
          parent_id = excluded.parent_id,
          time_updated = excluded.time_updated,
          info = COALESCE(excluded.info, session_binding.info)
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

    const listImages = sql<ImageRow>`
      SELECT * FROM gateway_image ORDER BY time_created, name
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(image)),
    );

    const getWorkspaceImage = Effect.fn("GatewayRegistry.getWorkspaceImage")(
      function* (workspaceID: Workspace.ID) {
        const rows = yield* sql<
          ImageRow & { workspace_id: string; time_updated: number }
        >`
          SELECT gateway_image.*, workspace_image.workspace_id, workspace_image.time_updated
          FROM workspace_image
          JOIN gateway_image ON gateway_image.name = workspace_image.image_name
          WHERE workspace_image.workspace_id = ${workspaceID}
        `.pipe(Effect.orDie);
        const row = rows[0];
        if (!row) return undefined;
        return {
          workspaceID: Workspace.ID.make(row.workspace_id),
          image: image(row),
          timeUpdated: row.time_updated,
        };
      },
    );

    const createSnapshotImage = Effect.fn(
      "GatewayRegistry.createSnapshotImage",
    )((input: SnapshotImageInput) =>
      insertSnapshotImage(input).pipe(
        sql.withTransaction,
        Effect.catchTag("SqlError", (error) => Effect.die(error)),
      ),
    );

    const nextSandboxGeneration = Effect.fn(
      "GatewayRegistry.nextSandboxGeneration",
    )(function* (workspaceID: Workspace.ID) {
      yield* requireWorkspace(workspaceID);
      const rows = yield* sql<{ generation: number }>`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation
        FROM sandbox
        WHERE workspace_id = ${workspaceID}
      `.pipe(Effect.orDie);
      return rows[0]?.generation ?? 1;
    });

    const findToolCall = Effect.fn("GatewayRegistry.findToolCall")(function* (
      sandboxID: string,
      toolCallID: string,
    ) {
      const rows = yield* sql<ToolCallRow>`
        SELECT * FROM gateway_tool_call
        WHERE sandbox_id = ${sandboxID} AND tool_call_id = ${toolCallID}
      `.pipe(Effect.orDie);
      return rows[0] ? toolCall(rows[0]) : undefined;
    });

    const recordToolInput = Effect.fn("GatewayRegistry.recordToolInput")(
      function* (input: {
        readonly sandboxID: string;
        readonly workspaceID: Workspace.ID;
        readonly sessionID: string;
        readonly assistantMessageID: string;
        readonly toolCallID: string;
        readonly tool: string;
        readonly time: number;
      }) {
        yield* sql`
          INSERT INTO gateway_tool_call (
            sandbox_id, tool_call_id, workspace_id, session_id,
            assistant_message_id, tool, input, status, time_created, time_updated
          ) VALUES (
            ${input.sandboxID}, ${input.toolCallID}, ${input.workspaceID},
            ${input.sessionID}, ${input.assistantMessageID}, ${input.tool}, '{}',
            'requested', ${input.time}, ${input.time}
          )
          ON CONFLICT(sandbox_id, tool_call_id) DO NOTHING
        `.pipe(Effect.orDie);
        const recorded = yield* findToolCall(input.sandboxID, input.toolCallID);
        if (!recorded)
          return yield* Effect.die(
            new Error(`Tool input was not recorded: ${input.toolCallID}`),
          );
        return recorded;
      },
    );

    const correlateToolCall = Effect.fn("GatewayRegistry.correlateToolCall")(
      function* (input: {
        readonly sandboxID: string;
        readonly toolCallID: string;
        readonly input: unknown;
        readonly time: number;
      }) {
        yield* sql`
          UPDATE gateway_tool_call
          SET input = ${JSON.stringify(input.input) ?? "null"}, time_updated = ${input.time}
          WHERE sandbox_id = ${input.sandboxID}
            AND tool_call_id = ${input.toolCallID}
            AND status = 'requested'
        `.pipe(Effect.orDie);
        return yield* findToolCall(input.sandboxID, input.toolCallID);
      },
    );

    const claimToolCall = Effect.fn("GatewayRegistry.claimToolCall")(
      (sandboxID: string, toolCallID: string, time: number) =>
        Effect.gen(function* () {
          const current = yield* findToolCall(sandboxID, toolCallID);
          if (!current || current.status !== "requested") return undefined;
          yield* sql`
            UPDATE gateway_tool_call
            SET status = 'running', time_updated = ${time}
            WHERE sandbox_id = ${sandboxID} AND tool_call_id = ${toolCallID}
              AND status = 'requested'
          `;
          return yield* findToolCall(sandboxID, toolCallID);
        }).pipe(sql.withTransaction, Effect.orDie),
    );

    const succeedToolCall = Effect.fn("GatewayRegistry.succeedToolCall")(
      (input: {
        readonly sandboxID: string;
        readonly toolCallID: string;
        readonly result: unknown;
        readonly time: number;
        readonly image?: SnapshotImageInput;
      }) =>
        Effect.gen(function* () {
          const current = yield* findToolCall(
            input.sandboxID,
            input.toolCallID,
          );
          if (!current || current.status !== "running") return undefined;
          if (
            input.image &&
            (input.image.sourceWorkspaceID !== current.workspaceID ||
              input.image.sourceSandboxID !== current.sandboxID)
          )
            return yield* Effect.die(
              new Error("Snapshot image ownership does not match tool call"),
            );
          if (input.image) yield* insertSnapshotImage(input.image);
          yield* sql`
            UPDATE gateway_tool_call
            SET status = 'succeeded', result = ${JSON.stringify(input.result) ?? "null"},
              time_updated = ${input.time}
            WHERE sandbox_id = ${input.sandboxID} AND tool_call_id = ${input.toolCallID}
              AND status = 'running'
          `;
          return yield* findToolCall(input.sandboxID, input.toolCallID);
        }).pipe(
          sql.withTransaction,
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
        ),
    );

    const failToolCall = Effect.fn("GatewayRegistry.failToolCall")(
      (input: {
        readonly sandboxID: string;
        readonly toolCallID: string;
        readonly error: unknown;
        readonly time: number;
      }) =>
        Effect.gen(function* () {
          const current = yield* findToolCall(
            input.sandboxID,
            input.toolCallID,
          );
          if (!current || current.status !== "running") return undefined;
          yield* sql`
            UPDATE gateway_tool_call
            SET status = 'failed', result = ${JSON.stringify(input.error) ?? "null"},
              time_updated = ${input.time}
            WHERE sandbox_id = ${input.sandboxID} AND tool_call_id = ${input.toolCallID}
              AND status = 'running'
          `;
          return yield* findToolCall(input.sandboxID, input.toolCallID);
        }).pipe(sql.withTransaction, Effect.orDie),
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
      finishSandbox,
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
      listImages,
      findImage,
      getWorkspaceImage,
      createSnapshotImage,
      nextSandboxGeneration,
      recordToolInput,
      correlateToolCall,
      findToolCall,
      claimToolCall,
      succeedToolCall,
      failToolCall,
    });
  }),
);
