export * as GatewayProcess from "./process.js";

import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { GatewayAggregate } from "./aggregate.js";
import { GatewayBackend } from "./backend.js";
import { GatewayDatabase } from "./database.js";
import { GatewayCredentials } from "./credentials.js";
import { GatewayControl } from "./control.js";
import { GatewayEvents } from "./events.js";
import { GatewayHandler } from "./handler.js";
import { GatewayModal } from "./modal.js";
import { GatewayReconcile } from "./reconcile.js";
import { GatewayRegistry } from "./registry.js";
import { GatewayProvision } from "./provision.js";
import { GatewayTools } from "./tools.js";

export interface Options {
  readonly hostname?: string;
  readonly port?: number;
  readonly password: string;
  readonly version: string;
  readonly database: string;
  readonly modal: GatewayModal.Options;
  readonly upstreamPort?: number;
  readonly root?: string;
  readonly upstreamPassword?: string;
  readonly credentialDatabase: string;
  readonly controlPlane: GatewayBackend.Connection;
}

export const start = Effect.fn("GatewayProcess.start")(function* (
  options: Options,
) {
  const database = GatewayDatabase.layer({ path: options.database });
  const registry = GatewayRegistry.layer.pipe(Layer.provide(database));
  const modal = GatewayModal.layer(options.modal);
  const credentials = GatewayCredentials.layer(options.credentialDatabase);
  const control = GatewayControl.layer(options.controlPlane);
  const dependencies = Layer.mergeAll(
    registry,
    modal,
    credentials,
    control,
    FetchHttpClient.layer,
  );
  const upstreamPassword = options.upstreamPassword ?? options.password;
  const backend = GatewayBackend.modalLayer({
    port: options.upstreamPort ?? 4096,
    password: upstreamPassword,
  }).pipe(Layer.provide(dependencies));
  const upstream = Layer.merge(dependencies, backend);
  const aggregate = GatewayAggregate.layer.pipe(Layer.provide(upstream));
  const provisionDeferred = yield* Deferred.make<GatewayProvision.Interface>();
  const tools = GatewayTools.layer({
    provision: Deferred.await(provisionDeferred),
    root: options.root ?? "/root",
  }).pipe(Layer.provide(upstream));
  const eventDependencies = Layer.merge(upstream, tools);
  const events = GatewayEvents.layer({ root: options.root }).pipe(
    Layer.provide(eventDependencies),
  );
  const provisionDependencies = Layer.mergeAll(upstream, tools, events);
  const provision = GatewayProvision.layer({
    root: options.root ?? "/root",
    upstreamPassword,
  }).pipe(Layer.provide(provisionDependencies));
  const services = Layer.mergeAll(
    upstream,
    aggregate,
    tools,
    events,
    provision,
  );
  const startup = GatewayReconcile.run().pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const provision = yield* GatewayProvision.Service;
        yield* Deferred.succeed(provisionDeferred, provision);
        const events = yield* GatewayEvents.Service;
        yield* events.watchControl(options.controlPlane);
        yield* events.start;
      }),
    ),
  );
  return yield* serve(options, services, startup);
});

export function serve<E, R>(
  options: Pick<Options, "hostname" | "port" | "password" | "version" | "root">,
  services: Layer.Layer<
    | GatewayRegistry.Service
    | GatewayBackend.Service
    | GatewayAggregate.Service
    | GatewayEvents.Service
    | GatewayControl.Service
    | GatewayProvision.Service
    | GatewayTools.Service
    | R,
    E
  >,
  startup: Effect.Effect<
    unknown,
    unknown,
    | GatewayRegistry.Service
    | GatewayBackend.Service
    | GatewayAggregate.Service
    | GatewayEvents.Service
    | GatewayControl.Service
    | GatewayProvision.Service
    | GatewayTools.Service
    | R
  > = Effect.void,
) {
  return Effect.gen(function* () {
    const runtime = ManagedRuntime.make(services);
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
    yield* Effect.promise(() => runtime.runPromise(startup));
    const server = Bun.serve({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 0,
      idleTimeout: 0,
      fetch: (request) =>
        runtime.runPromise(GatewayHandler.handle(request, options), {
          signal: request.signal,
        }),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)));
    return {
      url: server.url,
      stop: Effect.promise(() => server.stop(true)),
    };
  });
}
