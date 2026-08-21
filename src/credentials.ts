export * as GatewayCredentials from "./credentials.js";

import { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";

export interface Row {
  readonly id: string;
  readonly integration_id: string | null;
  readonly label: string;
  readonly value: string;
  readonly connector_id: string | null;
  readonly method_id: string | null;
  readonly active: number | null;
  readonly time_created: number;
  readonly time_updated: number;
}

export type Snapshot = readonly Row[];

export interface Interface {
  readonly snapshot: Snapshot;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Credentials",
) {}

export function layer(path: string) {
  return Layer.effect(
    Service,
    Effect.try({
      try: () => Service.of({ snapshot: read(path) }),
      catch: (cause) =>
        new Error(`Failed to snapshot OpenCode credentials from ${path}`, {
          cause,
        }),
    }),
  );
}

function read(path: string) {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database
      .query<Row, []>(
        `
        SELECT id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated
        FROM credential
      `,
      )
      .all();
  } finally {
    database.close();
  }
}
