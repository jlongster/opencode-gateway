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
    readonly imageID?: string;
  }) => Effect.Effect<{ readonly id: string }, ModalError>;
  readonly flushFilesystem: (
    sandboxID: string,
  ) => Effect.Effect<void, ModalError>;
  readonly snapshotFilesystem: (
    sandboxID: string,
  ) => Effect.Effect<string, ModalError>;
  readonly writeToolResponse: (
    sandboxID: string,
    callID: string,
    response: unknown,
  ) => Effect.Effect<void, ModalError>;
  readonly deleteImage: (imageID: string) => Effect.Effect<void, ModalError>;
  readonly running: (sandboxID: string) => Effect.Effect<boolean, ModalError>;
  readonly deleteDatabase: (
    sandboxID: string,
  ) => Effect.Effect<void, ModalError>;
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

      const running = Effect.fn("GatewayModal.running")((sandboxID: string) =>
        request("sandbox.poll", async () => {
          const sandbox = await client.sandboxes.fromId(sandboxID);
          try {
            return (await sandbox.poll()) === null;
          } finally {
            sandbox.detach();
          }
        }),
      );

      const deleteDatabase = Effect.fn("GatewayModal.deleteDatabase")(
        (sandboxID: string) =>
          request("sandbox.deleteDatabase", async () => {
            const sandbox = await client.sandboxes.fromId(sandboxID);
            try {
              const process = await sandbox.exec([
                "bash",
                "-lc",
                "rm -f /opencode/opencode.db /opencode/opencode.db-shm /opencode/opencode.db-wal && sync -f /opencode",
              ]);
              const code = await process.wait();
              if (code !== 0)
                throw new Error(
                  (await process.stderr.readText()).trim() ||
                    `database cleanup exited with code ${code}`,
                );
            } finally {
              sandbox.detach();
            }
          }),
      );

      const flushFilesystem = Effect.fn("GatewayModal.flushFilesystem")(
        (sandboxID: string) =>
          request("sandbox.flushFilesystem", async () => {
            const sandbox = await client.sandboxes.fromId(sandboxID);
            try {
              const process = await sandbox.exec(["sync"]);
              const code = await process.wait();
              if (code !== 0)
                throw new Error(
                  (await process.stderr.readText()).trim() ||
                    `sync exited with code ${code}`,
                );
            } finally {
              sandbox.detach();
            }
          }),
      );

      const snapshotFilesystem = Effect.fn("GatewayModal.snapshotFilesystem")(
        (sandboxID: string) =>
          request("sandbox.snapshotFilesystem", async () => {
            const sandbox = await client.sandboxes.fromId(sandboxID);
            try {
              const image = await sandbox.snapshotFilesystem({
                ttlMs: null,
                timeoutMs: 10 * 60 * 1000,
              });
              return image.imageId;
            } finally {
              sandbox.detach();
            }
          }),
      );

      const writeToolResponse = Effect.fn("GatewayModal.writeToolResponse")(
        (sandboxID: string, callID: string, response: unknown) =>
          request("sandbox.writeToolResponse", async () => {
            const sandbox = await client.sandboxes.fromId(sandboxID);
            try {
              const directory = "/tmp/opencode-gateway-tools";
              const mkdir = await sandbox.exec(["mkdir", "-p", directory]);
              const code = await mkdir.wait();
              if (code !== 0)
                throw new Error(
                  (await mkdir.stderr.readText()).trim() ||
                    `mkdir exited with code ${code}`,
                );
              await sandbox.filesystem.writeText(
                JSON.stringify(response),
                `${directory}/${encodeURIComponent(callID)}.json`,
              );
            } finally {
              sandbox.detach();
            }
          }),
      );

      const deleteImage = Effect.fn("GatewayModal.deleteImage")(
        (imageID: string) =>
          request("image.delete", () => client.images.delete(imageID)),
      );

      const create = Effect.fn("GatewayModal.create")(function* (input: {
        readonly installationID: string;
        readonly workspaceID: Workspace.ID;
        readonly generation: number;
        readonly volumeSubpath: string;
        readonly root: string;
        readonly upstreamPassword: string;
        readonly credentials: Snapshot;
        readonly imageID?: string;
      }) {
        const started = Date.now();
        yield* Effect.logInfo("creating Modal sandbox", {
          workspaceID: input.workspaceID,
          generation: input.generation,
          image: input.imageID ?? options.image ?? "oven/bun:1.3.14",
          opencodeVersion: options.opencodeVersion ?? "dev",
        });
        const image = input.imageID
          ? yield* request("image.fromId", () =>
              client.images.fromId(input.imageID!),
            )
          : client.images
              .fromRegistry(options.image ?? "oven/bun:1.3.14")
              .dockerfileCommands([
                "USER root",
                `RUN bun install -g @opencode-ai/cli@${quote(options.opencodeVersion ?? "dev")} --trust`,
                "RUN mkdir -p /opt/opencode-gateway-plugin && cd /opt/opencode-gateway-plugin && bun init -y && bun add @opencode-ai/plugin@dev",
              ]);
        const retained = yield* Ref.make(false);
        return yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            const sandbox = yield* request("sandbox.create", () =>
              client.sandboxes.create(app, image, {
                command: ["bash", "-lc", bootstrap({ root: input.root })],
                env: {
                  OPENCODE_PASSWORD: input.upstreamPassword,
                  OPENCODE_DB: "/opencode/opencode.db",
                  OPENCODE_CONFIG_CONTENT: JSON.stringify({
                    plugins: ["/tmp/opencode-gateway-plugin.js"],
                  }),
                },
                volumes: {
                  "/opencode": volume.withMountOptions({
                    subPath: input.volumeSubpath,
                  }),
                },
                workdir: input.root,
                timeoutMs: options.timeoutMs ?? 24 * 60 * 60 * 1000,
                idleTimeoutMs: 60_000,
                memoryMiB: 1024,
                memoryLimitMiB: 1024,
                experimentalOptions: { vm_runtime: true },
                readinessProbe: Probe.withTcp(4096, { intervalMs: 250 }),
                tags: {
                  [GatewayTag]: input.installationID,
                  [WorkspaceTag]: input.workspaceID,
                  [GenerationTag]: String(input.generation),
                },
              }),
            );
            yield* Effect.logInfo("Modal sandbox allocated", {
              workspaceID: input.workspaceID,
              sandboxID: sandbox.sandboxId,
              elapsedMs: Date.now() - started,
            });
            return sandbox;
          }),
          (sandbox) =>
            Effect.gen(function* () {
              yield* request("sandbox.writeCredentialImporter", () =>
                sandbox.filesystem.writeText(
                  credentialImporter,
                  "/tmp/opencode-credential-import.ts",
                ),
              );
              yield* request("sandbox.writeGatewayPlugin", () =>
                sandbox.filesystem.writeText(
                  gatewayPlugin,
                  "/tmp/opencode-gateway-plugin.js",
                ),
              );
              yield* request("sandbox.writeCredentials", () =>
                sandbox.stdin.writeText(JSON.stringify(input.credentials)),
              );
              yield* request("sandbox.closeCredentialInput", () =>
                sandbox.stdin.close(),
              );
              yield* Effect.logInfo("waiting for Modal sandbox readiness", {
                workspaceID: input.workspaceID,
                sandboxID: sandbox.sandboxId,
                elapsedMs: Date.now() - started,
              });
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
              yield* Effect.logInfo("Modal sandbox creation finished", {
                workspaceID: input.workspaceID,
                sandboxID: sandbox.sandboxId,
                durationMs: Date.now() - started,
              });
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
        ).pipe(
          Effect.tapError((error) =>
            Effect.logError("Modal sandbox creation failed", {
              workspaceID: input.workspaceID,
              durationMs: Date.now() - started,
              error,
            }),
          ),
        );
      });

      return Service.of({
        appID: app.appId,
        volumeID: volume.volumeId,
        listOwned,
        connect,
        create,
        flushFilesystem,
        snapshotFilesystem,
        writeToolResponse,
        deleteImage,
        running,
        deleteDatabase,
        terminate,
      });
    }),
  );
}

function bootstrap(input: { readonly root: string }) {
  return [
    "set -euo pipefail",
    "rm -rf /tmp/opencode-gateway-tools",
    "cat > /tmp/opencode-credentials.json",
    `cd ${quote(input.root)}`,
    "opencode2 serve --hostname 127.0.0.1 --port 4095 &",
    "bootstrap_pid=$!",
    `bun -e ${quote(healthWait)}`,
    'kill -TERM "$bootstrap_pid"',
    'wait "$bootstrap_pid" || true',
    "bun /tmp/opencode-credential-import.ts /tmp/opencode-credentials.json",
    "rm -f /tmp/opencode-credential-import.ts /tmp/opencode-credentials.json",
    "exec opencode2 serve --hostname 0.0.0.0 --port 4096",
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

const gatewayPlugin = `
import { Plugin } from "/opt/opencode-gateway-plugin/node_modules/@opencode-ai/plugin/dist/promise/index.js"
import { mkdir, readFile, rm } from "node:fs/promises"

const directory = "/tmp/opencode-gateway-tools"

export default Plugin.define({
  id: "opencode.gateway",
  setup: async (context) => {
    await context.tool.transform((tools) => {
      tools.add({
        name: "image_snapshot",
        options: {
          namespace: "gateway",
          permission: "gateway.image_snapshot",
          codemode: false,
        },
        description: "Save this workspace's VM filesystem as a named reusable gateway image.",
        input: {
          type: "object",
          properties: {
            name: {
              type: "string",
              pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
              description: "Immutable image name shown by /cd on the home screen.",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: async ({ name }, call) => {
          await mkdir(directory, { recursive: true })
          const file = directory + "/" + encodeURIComponent(call.id) + ".json"
          for (let attempt = 0; attempt < 3_000; attempt++) {
            const text = await readFile(file, "utf8").catch(() => undefined)
            if (text !== undefined) {
              await rm(file, { force: true })
              const response = JSON.parse(text)
              if (!response.ok) throw new Error(response.error || "Gateway operation failed")
              return { content: [{ type: "text", text: JSON.stringify(response.result) }] }
            }
            await Bun.sleep(250)
          }
          throw new Error("Timed out waiting for the OpenCode gateway")
        },
      })
    })
  },
})
`;

const credentialImporter = `
import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
const file = process.argv[2]
if (!file) throw new Error("Credential snapshot path is required")
const rows = await Bun.file(file).json()
if (!Array.isArray(rows)) throw new Error("Credential snapshot must be an array")
const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
const database = new Database(process.env.OPENCODE_DB ?? path.join(data, "opencode", "opencode.db"))
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
