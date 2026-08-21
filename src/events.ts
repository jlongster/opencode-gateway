export * as GatewayEvents from "./events.js";

import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event";
import { Event } from "@opencode-ai/schema/event";
import { Workspace } from "@opencode-ai/schema/workspace";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { GatewayBackend } from "./backend.js";
import { GatewayClient } from "./client.js";
import { GatewayRegistry } from "./registry.js";

const encoder = new TextEncoder();
const capacity = 256;
const encodeEvent = Schema.encodeUnknownSync(OpenCodeEvent);

interface Subscriber {
  readonly id: number;
  readonly queue: Uint8Array[];
  controller?: ReadableStreamDefaultController<Uint8Array>;
}

export interface Interface {
  readonly start: Effect.Effect<void>;
  readonly watch: (workspaceID: Workspace.ID) => Effect.Effect<void>;
  readonly watchControl: (
    connection: GatewayBackend.Connection,
  ) => Effect.Effect<void>;
  readonly publish: (
    event: OpenCodeEvent,
    workspaceID: Workspace.ID,
  ) => Effect.Effect<
    void,
    | GatewayRegistry.OwnershipConflictError
    | GatewayRegistry.WorkspaceNotFoundError
  >;
  readonly subscribe: Effect.Effect<Response>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Events",
) {}

export const layer = (options: { readonly root?: string } = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const backend = yield* GatewayBackend.Service;
      const registry = yield* GatewayRegistry.Service;
      const httpClient = yield* HttpClient.HttpClient;
      const scope = yield* Scope.Scope;
      const started = yield* Ref.make(false);
      const watched = new Set<Workspace.ID>();
      const controlStarted = yield* Ref.make(false);
      const subscribers = new Map<number, Subscriber>();
      const sequence = { value: 0 };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          subscribers.forEach((subscriber) => subscriber.controller?.close());
          subscribers.clear();
        }),
      );

      const fanout = (event: unknown) =>
        Effect.sync(() => {
          const bytes = encode(event);
          subscribers.forEach((subscriber) => {
            if (subscriber.queue.length >= capacity) {
              subscriber.controller?.error(
                new Error("Gateway event subscriber overflow"),
              );
              subscribers.delete(subscriber.id);
              return;
            }
            subscriber.queue.push(bytes);
            drain(subscriber);
          });
        });

      const publish = Effect.fn("GatewayEvents.publish")(function* (
        event: OpenCodeEvent,
        workspaceID: Workspace.ID,
      ) {
        if (event.type === "session.created") {
          yield* registry.registerProject({
            workspaceID,
            projectID: event.data.projectID,
            directory: event.data.location.directory,
            canonical: event.data.location.directory,
            time: DateTime.toEpochMillis(event.created),
          });
          yield* registry.registerSession({
            id: event.data.sessionID,
            workspaceID,
            projectID: event.data.projectID,
            parentID: event.data.parentID,
            timeCreated: DateTime.toEpochMillis(event.created),
            timeUpdated: DateTime.toEpochMillis(event.created),
          });
        }
        if (event.type === "session.forked") {
          const parent = yield* registry.findSession(event.data.parentID);
          if (parent)
            yield* registry.registerSession({
              id: event.data.sessionID,
              workspaceID: parent.workspaceID,
              projectID: parent.projectID,
              parentID: event.data.parentID,
              timeCreated: DateTime.toEpochMillis(event.created),
              timeUpdated: DateTime.toEpochMillis(event.created),
            });
        }
        if (event.type === "session.deleted")
          yield* registry.removeSession(event.data.sessionID);
        yield* fanout(translate(event, workspaceID));
      });

      const run = Effect.fnUntraced(function* (workspaceID: Workspace.ID) {
        const connection = yield* backend.connect(workspaceID);
        const client = yield* GatewayClient.make(connection, httpClient);
        return yield* client.event.subscribe().pipe(
          Stream.filter((event) => event.type !== "server.connected"),
          Stream.runForEach((event) => publish(event, workspaceID)),
        );
      });

      const watch = Effect.fn("GatewayEvents.watch")(function* (
        workspaceID: Workspace.ID,
      ) {
        if (watched.has(workspaceID)) return;
        if (!(yield* registry.currentSandbox(workspaceID))) return;
        watched.add(workspaceID);
        yield* run(workspaceID).pipe(
          Effect.tapError((error) =>
            Effect.logDebug("gateway upstream event stream disconnected", {
              workspaceID,
              error,
            }),
          ),
          Effect.retry(Schedule.spaced("5 seconds")),
          Effect.forkIn(scope),
        );
      });

      const watchControl = Effect.fn("GatewayEvents.watchControl")(function* (
        connection: GatewayBackend.Connection,
      ) {
        if (yield* Ref.getAndSet(controlStarted, true)) return;
        const run = Effect.gen(function* () {
          const client = yield* GatewayClient.make(connection, httpClient);
          return yield* client.event.subscribe().pipe(
            Stream.filter((event) => event.type !== "server.connected"),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                yield* fanout({
                  ...event,
                  location: { directory: options.root ?? "/persist/project" },
                });
                const workspaces = yield* registry.listWorkspaces;
                yield* Effect.forEach(
                  workspaces,
                  (workspace) =>
                    fanout({
                      ...event,
                      location: {
                        directory: workspace.directory,
                        workspaceID: workspace.id,
                      },
                    }),
                  { discard: true },
                );
              }),
            ),
          );
        });
        yield* run.pipe(
          Effect.tapError((error) =>
            Effect.logDebug("gateway control event stream disconnected", {
              error,
            }),
          ),
          Effect.retry(Schedule.spaced("5 seconds")),
          Effect.forkIn(scope),
        );
      });

      const start = Effect.gen(function* () {
        if (yield* Ref.getAndSet(started, true)) return;
        const workspaces = yield* registry.listWorkspaces;
        yield* Effect.forEach(workspaces, (workspace) => watch(workspace.id), {
          discard: true,
        });
      });

      const subscribe = Effect.sync(() => {
        const id = ++sequence.value;
        const subscriber: Subscriber = { id, queue: [] };
        const stream = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              subscriber.controller = controller;
              subscribers.set(id, subscriber);
              subscriber.queue.push(
                encode({
                  id: Event.ID.create(),
                  type: "server.connected",
                  created: DateTime.nowUnsafe(),
                  data: {},
                }),
              );
              drain(subscriber);
            },
            pull() {
              drain(subscriber);
            },
            cancel() {
              subscribers.delete(id);
            },
          },
          { highWaterMark: 1 },
        );
        return new Response(stream, {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream",
          },
        });
      });

      return Service.of({ start, watch, watchControl, publish, subscribe });
    }),
  );

function translate(event: OpenCodeEvent, workspaceID: Workspace.ID) {
  const location = event.location
    ? { ...event.location, workspaceID }
    : undefined;
  const data =
    typeof event.data === "object" &&
    event.data !== null &&
    "location" in event.data &&
    locationValue(event.data.location)
      ? { ...event.data, location: { ...event.data.location, workspaceID } }
      : event.data;
  return { ...event, location, data };
}

function locationValue(value: unknown): value is {
  readonly directory: string;
  readonly workspaceID?: Workspace.ID;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "directory" in value &&
    typeof value.directory === "string"
  );
}

function encode(event: unknown) {
  return encoder.encode(`data: ${JSON.stringify(encodeEvent(event))}\n\n`);
}

function drain(subscriber: Subscriber) {
  const controller = subscriber.controller;
  if (!controller) return;
  while ((controller.desiredSize ?? 0) > 0 && subscriber.queue.length > 0) {
    const value = subscriber.queue.shift();
    if (!value) return;
    controller.enqueue(value);
  }
}
