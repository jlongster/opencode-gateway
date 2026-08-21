export * as GatewayDatabase from "./database.js";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { mkdir } from "fs/promises";
import path from "path";

export interface Interface {
  readonly sql: SqlClient.SqlClient;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Database",
) {}

const fromClient = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA synchronous = NORMAL`;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS gateway (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        installation_id TEXT NOT NULL UNIQUE,
        time_created INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        volume_subpath TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS sandbox (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating', 'running', 'missing', 'finished', 'failed')),
        endpoint TEXT,
        time_created INTEGER NOT NULL,
        time_expires INTEGER,
        time_connected INTEGER,
        time_finished INTEGER,
        error TEXT,
        UNIQUE (workspace_id, generation)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS gateway_image (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('default', 'snapshot')),
        image_id TEXT,
        source_workspace_id TEXT REFERENCES workspace(id) ON DELETE SET NULL,
        source_sandbox_id TEXT,
        source_generation INTEGER,
        time_created INTEGER NOT NULL,
        CHECK (
          (kind = 'default' AND image_id IS NULL) OR
          (kind = 'snapshot' AND image_id IS NOT NULL)
        )
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO gateway_image (name, kind, time_created)
      VALUES ('default', 'default', ${Date.now()})
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS workspace_image (
        workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
        image_name TEXT NOT NULL REFERENCES gateway_image(name),
        time_updated INTEGER NOT NULL
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO workspace_image (workspace_id, image_name, time_updated)
      SELECT id, 'default', time_updated FROM workspace
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS gateway_tool_call (
        sandbox_id TEXT NOT NULL REFERENCES sandbox(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'succeeded', 'failed')),
        result TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        PRIMARY KEY (sandbox_id, tool_call_id)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS project_binding (
        workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
        upstream_project_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        canonical TEXT,
        time_updated INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS session_binding (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        upstream_project_id TEXT NOT NULL,
        parent_id TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS session_binding_workspace_idx
      ON session_binding(workspace_id, time_updated DESC)
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS resource_owner (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        sandbox_id TEXT NOT NULL REFERENCES sandbox(id) ON DELETE CASCADE,
        time_created INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS sandbox_quarantine (
        sandbox_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        tags TEXT NOT NULL,
        time_observed INTEGER NOT NULL
      )
    `;
    return { sql };
  }).pipe(Effect.orDie),
);

export function layer(options: { readonly path: string }) {
  return Layer.unwrap(
    Effect.promise(() =>
      mkdir(path.dirname(options.path), { recursive: true }),
    ).pipe(
      Effect.as(
        fromClient.pipe(
          Layer.provide(SqliteClient.layer({ filename: options.path })),
        ),
      ),
      Effect.orDie,
    ),
  );
}
