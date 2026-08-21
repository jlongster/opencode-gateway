export * as GatewayModal from "./modal.js";

import { Context, Effect, Layer, Ref, Schema } from "effect";
import { ModalClient, Probe } from "modal";
import { Workspace } from "@opencode-ai/schema/workspace";
import type { Snapshot } from "./credentials.js";

export const GatewayTag = "opencode_gateway";
export const WorkspaceTag = "opencode_workspace";
export const GenerationTag = "opencode_generation";

export interface ListedSandbox {
  readonly id: string;
  readonly tags: Readonly<Record<string, string>>;
}

export class ModalError extends Schema.TaggedErrorClass<ModalError>()(
  "GatewayModal.ModalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface Interface {
  readonly appID: string;
  readonly volumeID: string;
  readonly listOwned: (
    installationID: string,
  ) => Effect.Effect<ListedSandbox[], ModalError>;
  readonly connect: (
    sandboxID: string,
    port: number,
  ) => Effect.Effect<
    { readonly url: string; readonly token: string },
    ModalError
  >;
  readonly create: (input: {
    readonly installationID: string;
    readonly workspaceID: Workspace.ID;
    readonly generation: number;
    readonly volumeSubpath: string;
    readonly root: string;
    readonly upstreamPassword: string;
    readonly credentials: Snapshot;
  }) => Effect.Effect<{ readonly id: string }, ModalError>;
  readonly terminate: (sandboxID: string) => Effect.Effect<void, ModalError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/gateway/Modal",
) {}

export interface Options {
  readonly app: string;
  readonly volume: string;
  readonly environment?: string;
  readonly tokenID?: string;
  readonly tokenSecret?: string;
  readonly image?: string;
  readonly opencodeVersion?: string;
  readonly timeoutMs?: number;
}

export function layer(options: Options) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new ModalClient({
              ...(options.environment
                ? { environment: options.environment }
                : {}),
              ...(options.tokenID ? { tokenId: options.tokenID } : {}),
              ...(options.tokenSecret
                ? { tokenSecret: options.tokenSecret }
                : {}),
            }),
        ),
        (active) => Effect.sync(() => active.close()),
      );
      const app = yield* request("app.fromName", () =>
        client.apps.fromName(options.app, {
          createIfMissing: true,
          ...(options.environment ? { environment: options.environment } : {}),
        }),
      );
      const volume = yield* request("volume.fromName", () =>
        client.volumes.fromName(
          options.volume,
          options.environment
            ? { environment: options.environment }
            : undefined,
        ),
      );

      const listOwned = Effect.fn("GatewayModal.listOwned")(
        (installationID: string) =>
          request("sandbox.list", async () => {
            const result: ListedSandbox[] = [];
            for await (const sandbox of client.sandboxes.list({
              appId: app.appId,
              tags: { [GatewayTag]: installationID },
              ...(options.environment
                ? { environment: options.environment }
                : {}),
            })) {
              result.push({
                id: sandbox.sandboxId,
                tags: await sandbox.getTags(),
              });
              sandbox.detach();
            }
            return result;
          }),
      );

      const connect = Effect.fn("GatewayModal.connect")(
        (sandboxID: string, port: number) =>
          request("sandbox.createConnectToken", async () => {
            const sandbox = await client.sandboxes.fromId(sandboxID);
            const credentials = await sandbox.createConnectToken({ port });
            sandbox.detach();
            return credentials;
          }),
      );

      const terminate = Effect.fn("GatewayModal.terminate")(
        (sandboxID: string) =>
          request("sandbox.terminate", async () => {
            const sandbox = await client.sandboxes.fromId(sandboxID);
            await sandbox.terminate({ wait: true });
          }),
      );

      const create = Effect.fn("GatewayModal.create")(function* (input: {
        readonly installationID: string;
        readonly workspaceID: Workspace.ID;
        readonly generation: number;
        readonly volumeSubpath: string;
        readonly root: string;
        readonly upstreamPassword: string;
        readonly credentials: Snapshot;
      }) {
        const image = client.images
          .fromRegistry(options.image ?? "oven/bun:1.3.14")
          .dockerfileCommands([
            "USER root",
            `RUN bun install -g @opencode-ai/cli@${quote(options.opencodeVersion ?? "dev")} --trust`,
          ]);
        const retained = yield* Ref.make(false);
        return yield* Effect.acquireUseRelease(
          request("sandbox.create", () =>
            client.sandboxes.create(app, image, {
              command: ["bash", "-lc", bootstrap({ root: input.root })],
              env: {
                OPENCODE_PASSWORD: input.upstreamPassword,
                OPENCODE_DB: "/persist/opencode/opencode.db",
                OPENCODE_CONFIG_DIR: "/persist/opencode/config",
                XDG_DATA_HOME: "/persist/opencode/data",
                XDG_STATE_HOME: "/persist/opencode/state",
                XDG_CACHE_HOME: "/persist/opencode/cache",
              },
              volumes: {
                "/persist": volume.withMountOptions({
                  subPath: input.volumeSubpath,
                }),
              },
              workdir: "/persist",
              timeoutMs: options.timeoutMs ?? 24 * 60 * 60 * 1000,
              readinessProbe: Probe.withTcp(4096, { intervalMs: 250 }),
              tags: {
                [GatewayTag]: input.installationID,
                [WorkspaceTag]: input.workspaceID,
                [GenerationTag]: String(input.generation),
              },
            }),
          ),
          (sandbox) =>
            Effect.gen(function* () {
              yield* request("sandbox.writeCredentialImporter", () =>
                sandbox.filesystem.writeText(
                  credentialImporter,
                  "/tmp/opencode-credential-import.ts",
                ),
              );
              yield* request("sandbox.writeCredentials", () =>
                sandbox.stdin.writeText(JSON.stringify(input.credentials)),
              );
              yield* request("sandbox.closeCredentialInput", () =>
                sandbox.stdin.close(),
              );
              yield* request("sandbox.waitUntilReady", () =>
                sandbox.waitUntilReady(),
              ).pipe(
                Effect.catch((error) =>
                  Effect.all([
                    request("sandbox.stdout", () =>
                      sandbox.stdout.readText(),
                    ).pipe(Effect.orElseSucceed(() => "")),
                    request("sandbox.stderr", () =>
                      sandbox.stderr.readText(),
                    ).pipe(Effect.orElseSucceed(() => "")),
                  ]).pipe(
                    Effect.flatMap(([stdout, stderr]) =>
                      Effect.fail(
                        new ModalError({
                          operation: error.operation,
                          cause: new Error(
                            [stderr.trim(), stdout.trim()]
                              .filter(Boolean)
                              .join("\n") || causeText(error.cause),
                          ),
                        }),
                      ),
                    ),
                  ),
                ),
              );
              yield* Ref.set(retained, true);
              return { id: sandbox.sandboxId };
            }),
          (sandbox) =>
            Ref.get(retained).pipe(
              Effect.flatMap((keep) =>
                keep
                  ? Effect.sync(() => sandbox.detach())
                  : request("sandbox.terminate", () =>
                      sandbox.terminate({ wait: true }),
                    ).pipe(Effect.ignore),
              ),
            ),
        );
      });

      return Service.of({
        appID: app.appId,
        volumeID: volume.volumeId,
        listOwned,
        connect,
        create,
        terminate,
      });
    }),
  );
}

function bootstrap(input: { readonly root: string }) {
  return [
    "set -euo pipefail",
    "cat > /tmp/opencode-credentials.json",
    `mkdir -p ${quote(input.root)} /persist/opencode/{config,data,state,cache}`,
    'cp "$(command -v opencode2)" /tmp/opencode2 && chmod +x /tmp/opencode2',
    `cd ${quote(input.root)}`,
    "/tmp/opencode2 serve --hostname 127.0.0.1 --port 4095 &",
    "bootstrap_pid=$!",
    `bun -e ${quote(healthWait)}`,
    'kill -TERM "$bootstrap_pid"',
    'wait "$bootstrap_pid" || true',
    "bun /tmp/opencode-credential-import.ts /tmp/opencode-credentials.json",
    "rm -f /tmp/opencode-credential-import.ts /tmp/opencode-credentials.json",
    "exec /tmp/opencode2 serve --hostname 0.0.0.0 --port 4096",
  ].join("\n");
}

const healthWait = `
const headers = { authorization: "Basic " + btoa("opencode:" + process.env.OPENCODE_PASSWORD) }
for (let attempt = 0; attempt < 60; attempt++) {
  const ready = await fetch("http://127.0.0.1:4095/api/health", { headers }).then((response) => response.ok).catch(() => false)
  if (ready) process.exit(0)
  await Bun.sleep(1000)
}
process.exit(1)
`;

const credentialImporter = `
import { Database } from "bun:sqlite"
const file = process.argv[2]
if (!file) throw new Error("Credential snapshot path is required")
const rows = await Bun.file(file).json()
if (!Array.isArray(rows)) throw new Error("Credential snapshot must be an array")
const database = new Database(process.env.OPENCODE_DB)
const columns = database.query("PRAGMA table_info(credential)").all().map((column) => column.name)
const expected = ["id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_updated"]
if (expected.some((column) => !columns.includes(column))) throw new Error("OpenCode credential schema is incompatible")
const insert = database.prepare(\`
  INSERT INTO credential (
    id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
\`)
database.transaction((values) => {
  database.run("DELETE FROM credential")
  for (const row of values)
    insert.run(
      row.id,
      row.integration_id,
      row.label,
      row.value,
      row.connector_id,
      row.method_id,
      row.active,
      row.time_created,
      row.time_updated,
    )
})(rows)
database.close()
`;

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function causeText(cause: unknown) {
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}

function request<A>(operation: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new ModalError({ operation, cause }),
  });
}
