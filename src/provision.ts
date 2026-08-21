export * as GatewayProvision from "./provision.js";

import { Agent } from "@opencode-ai/schema/agent";
import { Model } from "@opencode-ai/schema/model";
import { Session } from "@opencode-ai/schema/session";
import { AbsolutePath } from "@opencode-ai/schema/schema";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { GatewayBackend } from "./backend.js";
import { GatewayClient } from "./client.js";
import { GatewayCredentials } from "./credentials.js";
import { GatewayEvents } from "./events.js";
import { GatewayModal } from "./modal.js";
import { GatewayRegistry } from "./registry.js";

export const Input = Schema.Struct({
  id: Schema.optional(Session.ID),
  title: Schema.optional(Schema.String),
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
});
export type Input = typeof Input.Type;

export class ProvisionError extends Schema.TaggedErrorClass<ProvisionError>()(
  "GatewayProvision.ProvisionError",
  {
    cause: Schema.Defect(),
  },
) {}

export interface Interface {
  readonly create: (
    input: Input,
  ) => Effect.Effect<Session.Info, ProvisionError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Provision",
) {}

export function layer(options: {
  readonly root: string;
  readonly upstreamPassword: string;
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const registry = yield* GatewayRegistry.Service;
      const modal = yield* GatewayModal.Service;
      const backend = yield* GatewayBackend.Service;
      const credentials = yield* GatewayCredentials.Service;
      const events = yield* GatewayEvents.Service;
      const httpClient = yield* HttpClient.HttpClient;

      const existing = Effect.fnUntraced(function* (sessionID: Session.ID) {
        const binding = yield* registry.findSession(sessionID);
        if (!binding) return undefined;
        const connection = yield* backend.connect(binding.workspaceID);
        const client = yield* GatewayClient.make(connection, httpClient);
        const session = yield* client.session.get({ sessionID });
        return {
          ...session,
          location: { ...session.location, workspaceID: binding.workspaceID },
        };
      });

      const create = Effect.fn("GatewayProvision.create")((input: Input) =>
        Effect.gen(function* () {
          if (input.id) {
            const recorded = yield* existing(input.id);
            if (recorded) return recorded;
          }
          const installationID = yield* registry.installationID;
          const workspace = yield* registry.createWorkspace({
            directory: options.root,
          });
          const sandbox = yield* modal
            .create({
              installationID,
              workspaceID: workspace.id,
              generation: 1,
              volumeSubpath: workspace.volumeSubpath,
              root: options.root,
              upstreamPassword: options.upstreamPassword,
              credentials: credentials.snapshot,
            })
            .pipe(Effect.onError(() => registry.removeWorkspace(workspace.id)));
          return yield* Effect.gen(function* () {
            yield* registry.registerSandbox({
              id: sandbox.id,
              workspaceID: workspace.id,
              generation: 1,
              status: "running",
              timeCreated: Date.now(),
            });
            yield* events.watch(workspace.id);
            const connection = yield* backend.connect(workspace.id);
            const client = yield* GatewayClient.make(connection, httpClient);
            const session = yield* client.session.create({
              ...input,
              location: { directory: AbsolutePath.make(options.root) },
            });
            yield* registry.registerProject({
              workspaceID: workspace.id,
              projectID: session.projectID,
              directory: session.location.directory,
              canonical: session.location.directory,
              time: DateTime.toEpochMillis(session.time.updated),
            });
            yield* registry.registerSession({
              id: session.id,
              workspaceID: workspace.id,
              projectID: session.projectID,
              parentID: session.parentID,
              timeCreated: DateTime.toEpochMillis(session.time.created),
              timeUpdated: DateTime.toEpochMillis(session.time.updated),
            });
            return {
              ...session,
              location: { ...session.location, workspaceID: workspace.id },
            };
          }).pipe(
            Effect.onError(() =>
              Effect.all(
                [
                  modal.terminate(sandbox.id).pipe(Effect.ignore),
                  registry.removeWorkspace(workspace.id),
                ],
                {
                  discard: true,
                },
              ),
            ),
          );
        }).pipe(Effect.mapError((cause) => new ProvisionError({ cause }))),
      );

      return Service.of({ create });
    }),
  );
}
