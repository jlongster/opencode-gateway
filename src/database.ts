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
