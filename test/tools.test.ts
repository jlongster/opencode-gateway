import { afterEach, expect, test } from "bun:test";
import type { OpenCodeEvent } from "@opencode-ai/protocol/groups/event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayDatabase } from "../src/database";
import { GatewayModal } from "../src/modal";
import { GatewayRegistry } from "../src/registry";
import { GatewayTools } from "../src/tools";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("snapshots a named image once for replayed native tool events", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "opencode-gateway-tools-"),
  );
  directories.push(directory);
  const database = GatewayDatabase.layer({
    path: path.join(directory, "gateway.db"),
  });
  const registry = GatewayRegistry.layer.pipe(Layer.provide(database));
  const snapshots = { count: 0 };
  const responses: unknown[] = [];
  const modal = Layer.succeed(
    GatewayModal.Service,
    GatewayModal.Service.of({
      appID: "ap_test",
      volumeID: "vo_test",
      listOwned: () => Effect.succeed([]),
      connect: () => Effect.die(new Error("not used")),
      create: () => Effect.die(new Error("not used")),
      terminate: () => Effect.void,
      flushFilesystem: () => Effect.void,
      snapshotFilesystem: () =>
        Effect.sync(() => {
          snapshots.count++;
          return "im_snapshot";
        }),
      writeToolResponse: (_sandboxID, _callID, response) =>
        Effect.sync(() => {
          responses.push(response);
        }),
      deleteImage: () => Effect.void,
      running: () => Effect.succeed(true),
    }),
  );
  const dependencies = Layer.merge(registry, modal);
  const tools = GatewayTools.layer.pipe(Layer.provide(dependencies));
  const runtime = ManagedRuntime.make(Layer.merge(dependencies, tools));

  try {
    const source = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* GatewayRegistry.Service;
        const workspace = yield* registry.createWorkspace({
          directory: "/persist/project",
        });
        return yield* registry.registerSandbox({
          id: "sb_test",
          workspaceID: workspace.id,
          generation: 1,
          status: "running",
          timeCreated: Date.now(),
        });
      }),
    );
    const started = toolEvent("session.tool.input.started", {
      sessionID: "ses_test",
      assistantMessageID: "msg_test",
      id: "call_test",
      name: "gateway_image_snapshot",
    });
    const called = toolEvent("session.tool.called", {
      sessionID: "ses_test",
      assistantMessageID: "msg_test",
      id: "call_test",
      input: { name: "node-tools" },
      executed: false,
    });
    await runtime.runPromise(
      GatewayTools.Service.use((tools) => tools.observe(started, source)),
    );
    await runtime.runPromise(
      GatewayTools.Service.use((tools) => tools.observe(called, source)),
    );
    await eventually(() => responses.length === 1);

    const images = await runtime.runPromise(
      GatewayRegistry.Service.use((registry) => registry.listImages),
    );
    expect(images.map((image) => image.name)).toEqual([
      "default",
      "node-tools",
    ]);
    expect(snapshots.count).toBe(1);
    expect(responses[0]).toMatchObject({ ok: true });

    await runtime.runPromise(
      GatewayTools.Service.use((tools) => tools.observe(called, source)),
    );
    await eventually(() => responses.length === 2);
    expect(snapshots.count).toBe(1);
  } finally {
    await runtime.dispose();
  }
});

function toolEvent(type: string, data: Record<string, unknown>) {
  return {
    id: "evt_test",
    type,
    created: new Date().toISOString(),
    data,
  } as unknown as OpenCodeEvent;
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition was not met");
}
