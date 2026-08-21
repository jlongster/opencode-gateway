import { OpenCode } from "@opencode-ai/client/effect";
import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { GatewayAggregate } from "../src/aggregate";
import { GatewayBackend } from "../src/backend";
import { GatewayDatabase } from "../src/database";
import { GatewayControl } from "../src/control";
import { GatewayEvents } from "../src/events";
import { GatewayProcess } from "../src/process";
import { GatewayProvision } from "../src/provision";
import { GatewayRegistry } from "../src/registry";
import { GatewayTools } from "../src/tools";

const upstream = process.env.DRIVE_UPSTREAM_URL;
const upstreamPassword = process.env.DRIVE_UPSTREAM_PASSWORD;
const gatewayPassword =
  process.env.OPENCODE_GATEWAY_PASSWORD ?? "gateway-drive";
const databasePath =
  process.env.OPENCODE_GATEWAY_DB ?? "/tmp/opencode/gateway-drive.db";
const port = Number(process.env.OPENCODE_GATEWAY_PORT ?? 38100);

if (!upstream) throw new Error("DRIVE_UPSTREAM_URL is required");
if (!upstreamPassword) throw new Error("DRIVE_UPSTREAM_PASSWORD is required");

const database = GatewayDatabase.layer({ path: databasePath });
const registry = GatewayRegistry.layer.pipe(Layer.provide(database));
const backend = Layer.succeed(
  GatewayBackend.Service,
  GatewayBackend.Service.of({
    connect: () =>
      Effect.succeed({
        url: upstream,
        headers: {
          authorization: `Basic ${btoa(`opencode:${upstreamPassword}`)}`,
        },
      }),
  }),
);
const dependencies = Layer.mergeAll(registry, backend, FetchHttpClient.layer);
const aggregate = GatewayAggregate.layer.pipe(Layer.provide(dependencies));
const tools = Layer.succeed(
  GatewayTools.Service,
  GatewayTools.Service.of({ observe: () => Effect.void }),
);
const events = GatewayEvents.layer().pipe(
  Layer.provide(Layer.merge(dependencies, tools)),
);
const provision = Layer.succeed(
  GatewayProvision.Service,
  GatewayProvision.Service.of({
    create: () => Effect.die(new Error("not used by the Drive harness")),
    resume: () => Effect.die(new Error("not used by the Drive harness")),
    terminate: () => Effect.die(new Error("not used by the Drive harness")),
  }),
);
const control = GatewayControl.layer({
  url: upstream,
  headers: { authorization: `Basic ${btoa(`opencode:${upstreamPassword}`)}` },
});
const services = Layer.mergeAll(
  dependencies,
  aggregate,
  tools,
  events,
  provision,
  control,
);

const bootstrap = Effect.gen(function* () {
  const registry = yield* GatewayRegistry.Service;
  const backend = yield* GatewayBackend.Service;
  const httpClient = yield* HttpClient.HttpClient;
  const existing = yield* registry.listWorkspaces;
  const workspace =
    existing[0] ??
    (yield* registry.createWorkspace({ directory: "/drive/project" }));
  yield* registry.registerSandbox({
    id: "sb_drive",
    workspaceID: workspace.id,
    generation: 1,
    status: "running",
    endpoint: upstream,
    timeCreated: Date.now(),
  });
  const connection = yield* backend.connect(workspace.id);
  const configured = HttpClient.mapRequest(
    httpClient,
    HttpClientRequest.setHeaders(connection.headers),
  );
  const client = yield* OpenCode.make({ baseUrl: connection.url }).pipe(
    Effect.provideService(HttpClient.HttpClient, configured),
  );
  const location = yield* client.location.get();
  const listed = yield* client.session.list({
    parentID: null,
    limit: 50,
    order: "desc",
  });
  const session =
    listed.data[0] ?? (yield* client.session.create({ location }));
  yield* registry.registerProject({
    workspaceID: workspace.id,
    projectID: session.projectID,
    directory: session.location.directory,
    canonical: session.location.directory,
    time: Date.now(),
  });
  yield* registry.registerSession({
    id: session.id,
    workspaceID: workspace.id,
    projectID: session.projectID,
    parentID: session.parentID,
    timeCreated: Date.now(),
    timeUpdated: Date.now(),
  });
  const gatewayEvents = yield* GatewayEvents.Service;
  yield* gatewayEvents.start;
  yield* Effect.logInfo("drive gateway ready", {
    gateway: `http://127.0.0.1:${port}`,
    sessionID: session.id,
    workspaceID: workspace.id,
  });
});

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* GatewayProcess.serve(
        {
          hostname: "127.0.0.1",
          port,
          password: gatewayPassword,
          version: "drive",
          root: "/drive/project",
        },
        services,
        bootstrap,
      );
      return yield* Effect.never;
    }),
  ),
);
