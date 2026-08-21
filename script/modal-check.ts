import { OpenCode, type OpenCodeEvent } from "@opencode-ai/client";

const url = process.env.OPENCODE_GATEWAY_URL ?? "http://127.0.0.1:4097";
const password = process.env.OPENCODE_GATEWAY_PASSWORD;
if (!password) throw new Error("OPENCODE_GATEWAY_PASSWORD is required");

const client = OpenCode.make({
  baseUrl: url,
  headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
});

assert((await client.health.get()).healthy, "health");
const listed = await client.session.list({
  parentID: null,
  limit: 50,
  order: "desc",
});
assert(listed.data.length >= 2, "two provisioned sessions");
const workspaces = new Set(
  listed.data.map((session) => session.location.workspaceID),
);
assert(
  workspaces.size === listed.data.length,
  "one workspace per user-created session",
);

await Promise.all(
  listed.data.flatMap((session) => {
    const location = {
      directory: session.location.directory,
      workspace: session.location.workspaceID,
    };
    return [
      client.session.get({ sessionID: session.id }),
      client.model.list({ location }),
      client.agent.list({ location }),
    ];
  }),
);

const events = client.event.subscribe()[Symbol.asyncIterator]();
assert(
  (await nextEvent(events)).type === "server.connected",
  "connected event",
);
const selected = listed.data[0];
const title = `Modal gateway verified ${Date.now()}`;
await client.session.rename({ sessionID: selected.id, title });
const renamed = await waitForEvent(
  events,
  (event) =>
    event.type === "session.renamed" && event.data.sessionID === selected.id,
);
assert(
  renamed.location?.workspaceID === selected.location.workspaceID,
  "event workspace",
);
await events.return?.();

const repeated = await Promise.all(
  Array.from({ length: 10 }, () =>
    client.session.list({ parentID: null, limit: 50, order: "desc" }),
  ),
);
assert(
  repeated.every((response) => response.data.length === listed.data.length),
  "consistent aggregate listing",
);
await client.session.active();

console.log(
  JSON.stringify(
    {
      sessions: listed.data.length,
      distinctWorkspaces: workspaces.size,
      routing: "passed",
      catalogs: "passed",
      events: "passed",
      aggregateReads: repeated.length,
    },
    undefined,
    2,
  ),
);

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Modal gateway check failed: ${label}`);
}

async function nextEvent(iterator: AsyncIterator<OpenCodeEvent>) {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for gateway event")),
        10_000,
      ),
    ),
  ]);
  if (result.done) throw new Error("Gateway event stream closed");
  return result.value;
}

async function waitForEvent(
  iterator: AsyncIterator<OpenCodeEvent>,
  predicate: (event: OpenCodeEvent) => boolean,
) {
  while (true) {
    const event = await nextEvent(iterator);
    if (predicate(event)) return event;
  }
}
