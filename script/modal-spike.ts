import {
  ModalClient,
  Probe,
  type App,
  type Image,
  type Sandbox,
  type Volume,
} from "modal";

const APP_NAME = "opencode-gateway-dev";
const VOLUME_NAME = "opencode-gateway-workspaces-dev";
const PORT = 4096;
const GATEWAY_ID = "gw_modal_spike";
const WORKSPACE_ID = `wrk_spike_${crypto.randomUUID().replaceAll("-", "")}`;
const SUBPATH = `/spikes/${WORKSPACE_ID}`;
const SERVER = String.raw`
const encoder = new TextEncoder()
Bun.serve({
  port: 4096,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/api/health")
      return Response.json({ healthy: true, pid: process.pid })
    if (url.pathname === "/api/event")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("data: connected\n\n"))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    if (url.pathname === "/ws" && server.upgrade(request)) return
    return new Response("not found", { status: 404 })
  },
  websocket: {
    message(socket, message) {
      socket.send(message)
    },
  },
})
await new Promise(() => {})
`;

const client = new ModalClient();
const sandboxes: Sandbox[] = [];

try {
  const app = await client.apps.fromName(APP_NAME, { createIfMissing: true });
  const volume = await client.volumes.fromName(VOLUME_NAME);
  const image = client.images.fromRegistry("oven/bun:1.3.14");
  const first = await createSandbox(app, image, volume, 1);
  sandboxes.push(first);
  await first.waitUntilReady();

  const credentials = await first.createConnectToken({ port: PORT });
  const health = await fetch(new URL("/api/health", credentials.url), {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  if (!health.ok) throw new Error(`Health request failed: ${health.status}`);

  const stream = await fetch(new URL("/api/event", credentials.url), {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  if (!stream.ok || !stream.body)
    throw new Error(`SSE request failed: ${stream.status}`);
  const reader = stream.body.getReader();
  const firstEvent = await reader.read();
  if (
    firstEvent.done ||
    !new TextDecoder().decode(firstEvent.value).includes("connected")
  )
    throw new Error("SSE stream did not deliver its initial event");

  const websocket = await connectWebSocket(credentials.url, credentials.token);
  websocket.send("gateway-spike");
  const echoed = await websocketMessage(websocket);
  if (echoed !== "gateway-spike")
    throw new Error(`WebSocket echo mismatch: ${echoed}`);
  websocket.close();

  const write = await first.exec([
    "bun",
    "-e",
    String.raw`
      import { Database } from "bun:sqlite"
      import { mkdir } from "node:fs/promises"
      await mkdir("/persist/project", { recursive: true })
      await mkdir("/persist/opencode", { recursive: true })
      await Bun.write("/persist/project/checkpoint.txt", "volume-v2")
      const db = new Database("/persist/opencode/opencode.db")
      db.run("PRAGMA journal_mode = WAL")
      db.run("CREATE TABLE checkpoint (value TEXT NOT NULL)")
      db.run("INSERT INTO checkpoint VALUES (?)", ["sqlite-v2"])
      db.close()
    `,
  ]);
  if ((await write.wait()) !== 0)
    throw new Error(`Volume write failed: ${await write.stderr.readText()}`);
  await sync(first);

  const listed = [];
  for await (const sandbox of client.sandboxes.list({
    appId: app.appId,
    tags: { opencode_gateway: GATEWAY_ID },
  })) {
    listed.push(sandbox.sandboxId);
    sandbox.detach();
  }
  if (!listed.includes(first.sandboxId))
    throw new Error("Owned sandbox was not discoverable by tag");

  await reader.cancel();
  await first.terminate({ wait: true });
  sandboxes.splice(sandboxes.indexOf(first), 1);

  const second = await createSandbox(app, image, volume, 2);
  sandboxes.push(second);
  await second.waitUntilReady();
  const read = await second.exec([
    "bun",
    "-e",
    String.raw`
      import { Database } from "bun:sqlite"
      const file = await Bun.file("/persist/project/checkpoint.txt").text()
      const db = new Database("/persist/opencode/opencode.db", { readonly: true })
      const row = db.query("SELECT value FROM checkpoint").get()
      db.close()
      console.log(JSON.stringify({ file, value: row?.value }))
    `,
  ]);
  if ((await read.wait()) !== 0)
    throw new Error(`Replacement read failed: ${await read.stderr.readText()}`);
  const restored = JSON.parse((await read.stdout.readText()).trim());
  if (restored.file !== "volume-v2" || restored.value !== "sqlite-v2")
    throw new Error(`Replacement state mismatch: ${JSON.stringify(restored)}`);

  const cleanup = await second.exec([
    "bash",
    "-lc",
    "rm -rf /persist/project /persist/opencode && sync /persist",
  ]);
  if ((await cleanup.wait()) !== 0)
    throw new Error(
      `Volume cleanup failed: ${await cleanup.stderr.readText()}`,
    );

  console.log(
    JSON.stringify(
      {
        appID: app.appId,
        volumeID: volume.volumeId,
        workspaceID: WORKSPACE_ID,
        http: "passed",
        sse: "passed",
        websocket: "passed",
        tags: "passed",
        replacement: "passed",
      },
      undefined,
      2,
    ),
  );
} finally {
  await Promise.allSettled(
    sandboxes.map((sandbox) => sandbox.terminate({ wait: true })),
  );
  client.close();
}

async function createSandbox(
  app: App,
  image: Image,
  volume: Volume,
  generation: number,
) {
  return client.sandboxes.create(app, image, {
    command: ["bun", "-e", SERVER],
    volumes: { "/persist": volume.withMountOptions({ subPath: SUBPATH }) },
    workdir: "/persist",
    timeoutMs: 10 * 60 * 1000,
    idleTimeoutMs: 60 * 1000,
    readinessProbe: Probe.withTcp(PORT, { intervalMs: 250 }),
    tags: {
      opencode_gateway: GATEWAY_ID,
      opencode_workspace: WORKSPACE_ID,
      opencode_generation: String(generation),
    },
  });
}

async function sync(sandbox: Sandbox) {
  const process = await sandbox.exec(["sync", "/persist"]);
  if ((await process.wait()) !== 0)
    throw new Error(`Volume sync failed: ${await process.stderr.readText()}`);
}

async function connectWebSocket(base: string, token: string) {
  const url = new URL("/ws", base);
  url.protocol = "wss:";
  url.searchParams.set("_modal_connect_token", token);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket connection failed")),
      { once: true },
    );
  });
  return socket;
}

function websocketMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket message failed")),
      { once: true },
    );
  });
}
