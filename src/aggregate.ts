export * as GatewayAggregate from "./aggregate.js";

import { Session } from "@opencode-ai/schema/session";
import { Workspace } from "@opencode-ai/schema/workspace";
import { Context, DateTime, Effect, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";
import { GatewayBackend } from "./backend.js";
import { GatewayClient } from "./client.js";
import { GatewayRegistry } from "./registry.js";

export interface SessionListInput {
  readonly workspaceID?: Workspace.ID;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
  readonly search?: string;
  readonly parentID?: string | null;
}

export interface Interface {
  readonly sessions: (
    input: SessionListInput,
  ) => Effect.Effect<ReadonlyArray<Session.Info>>;
  readonly active: Effect.Effect<
    Readonly<Record<string, { readonly type: "running" }>>
  >;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Aggregate",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const backend = yield* GatewayBackend.Service;
    const registry = yield* GatewayRegistry.Service;
    const httpClient = yield* HttpClient.HttpClient;

    const client = Effect.fnUntraced(function* (workspaceID: Workspace.ID) {
      const connection = yield* backend.connect(workspaceID);
      return yield* GatewayClient.make(connection, httpClient);
    });

    const sessions = Effect.fn("GatewayAggregate.sessions")(function* (
      input: SessionListInput,
    ) {
      const workspaces = input.workspaceID
        ? [yield* registry.getWorkspace(input.workspaceID)].filter(
            (item) => item !== undefined,
          )
        : yield* registry.listWorkspaces;
      const responses = yield* Effect.forEach(
        workspaces,
        (workspace) =>
          client(workspace.id).pipe(
            Effect.flatMap((api) =>
              api.session.list({
                limit: input.limit,
                order: input.order,
                search: input.search,
                parentID:
                  input.parentID === undefined
                    ? undefined
                    : input.parentID === null
                      ? null
                      : Session.ID.make(input.parentID),
              }),
            ),
            Effect.map((response) =>
              response.data.map((session) => ({
                ...session,
                location: { ...session.location, workspaceID: workspace.id },
              })),
            ),
            Effect.option,
          ),
        { concurrency: 8 },
      );
      const discovered = responses.flatMap((response) =>
        response._tag === "Some" ? response.value : [],
      );
      const grouped = Map.groupBy(discovered, (session) => session.id);
      const found = yield* Effect.forEach([...grouped.values()], (sessions) =>
        registry
          .findSession(sessions[0].id)
          .pipe(
            Effect.map(
              (binding) =>
                sessions.find(
                  (session) =>
                    session.location.workspaceID === binding?.workspaceID,
                ) ?? sessions[0],
            ),
          ),
      );
      yield* Effect.forEach(
        found,
        (session) =>
          registry
            .registerSession({
              id: session.id,
              workspaceID: session.location.workspaceID,
              projectID: session.projectID,
              parentID: session.parentID,
              timeCreated: DateTime.toEpochMillis(session.time.created),
              timeUpdated: DateTime.toEpochMillis(session.time.updated),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "gateway session discovery ownership conflict",
                  { sessionID: session.id, error },
                ),
              ),
            ),
        { discard: true },
      );
      const order = input.order ?? "desc";
      const sorted = found.toSorted((first, second) => {
        const firstUpdated = DateTime.toEpochMillis(first.time.updated);
        const secondUpdated = DateTime.toEpochMillis(second.time.updated);
        return order === "asc"
          ? firstUpdated - secondUpdated
          : secondUpdated - firstUpdated;
      });
      return input.limit === undefined ? sorted : sorted.slice(0, input.limit);
    });

    const active = Effect.gen(function* () {
      const workspaces = yield* registry.listWorkspaces;
      const responses = yield* Effect.forEach(
        workspaces,
        (workspace) =>
          client(workspace.id).pipe(
            Effect.flatMap((api) => api.session.active()),
            Effect.option,
          ),
        { concurrency: 8 },
      );
      return Object.assign(
        {},
        ...responses.flatMap((response) =>
          response._tag === "Some" ? [response.value] : [],
        ),
      );
    });

    return Service.of({ sessions, active });
  }),
);
