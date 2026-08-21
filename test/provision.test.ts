import { afterEach, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { GatewayBackend } from "../src/backend";
import { GatewayCredentials } from "../src/credentials";
import { GatewayDatabase } from "../src/database";
import { GatewayEvents } from "../src/events";
import { GatewayModal } from "../src/modal";
import { GatewayProvision } from "../src/provision";
import { GatewayRegistry } from "../src/registry";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("removes the workspace when Modal creation fails", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-gateway-provision-"),
  );
  directories.push(directory);
  const database = GatewayDatabase.layer({
    path: path.join(directory, "gateway.db"),
  });
  const registry = GatewayRegistry.layer.pipe(Layer.provide(database));
  const modal = Layer.succeed(
    GatewayModal.Service,
    GatewayModal.Service.of({
      appID: "ap_test",
      volumeID: "vo_test",
      listOwned: () => Effect.succeed([]),
      connect: () => Effect.die(new Error("not used")),
      create: () =>
        Effect.fail(
          new GatewayModal.ModalError({
            operation: "sandbox.create",
            cause: new Error("failed"),
          }),
        ),
      terminate: () => Effect.void,
    }),
  );
  const backend = Layer.succeed(
    GatewayBackend.Service,
    GatewayBackend.Service.of({
      connect: () => Effect.die(new Error("not used")),
    }),
  );
  const credentials = Layer.succeed(
    GatewayCredentials.Service,
    GatewayCredentials.Service.of({ snapshot: [] }),
  );
  const events = Layer.succeed(
    GatewayEvents.Service,
    GatewayEvents.Service.of({
      start: Effect.void,
      watch: () => Effect.void,
      watchControl: () => Effect.void,
      publish: () => Effect.void,
      subscribe: Effect.die(new Error("not used")),
    }),
  );
  const dependencies = Layer.mergeAll(
    registry,
    modal,
    backend,
    credentials,
    events,
    FetchHttpClient.layer,
  );
  const provision = GatewayProvision.layer({
    root: "/persist/project",
    upstreamPassword: "secret",
  }).pipe(Layer.provide(dependencies));
  const runtime = ManagedRuntime.make(Layer.merge(dependencies, provision));

  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const provision = yield* GatewayProvision.Service;
        const exit = yield* provision.create({}).pipe(Effect.exit);
        const registry = yield* GatewayRegistry.Service;
        return { exit, workspaces: yield* registry.listWorkspaces };
      }),
    );
    expect(result.exit._tag).toBe("Failure");
    expect(result.workspaces).toEqual([]);
  } finally {
    await runtime.dispose();
  }
});
