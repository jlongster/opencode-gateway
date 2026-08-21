import { OpenCode, type OpenCodeEvent } from "@opencode-ai/client";

const gatewayURL = process.env.OPENCODE_GATEWAY_URL ?? "http://127.0.0.1:38100";
const gatewayPassword =
  process.env.OPENCODE_GATEWAY_PASSWORD ?? "gateway-drive";
const upstreamURL = process.env.DRIVE_UPSTREAM_URL;
const upstreamPassword = process.env.DRIVE_UPSTREAM_PASSWORD;

if (!upstreamURL) throw new Error("DRIVE_UPSTREAM_URL is required");
if (!upstreamPassword) throw new Error("DRIVE_UPSTREAM_PASSWORD is required");

const gateway = OpenCode.make({
  baseUrl: gatewayURL,
  headers: { authorization: `Basic ${btoa(`opencode:${gatewayPassword}`)}` },
});
const upstream = OpenCode.make({
  baseUrl: upstreamURL,
  headers: { authorization: `Basic ${btoa(`opencode:${upstreamPassword}`)}` },
});

const health = await gateway.health.get();
assert(health.healthy, "gateway health");

const initial = await gateway.session.list({
  parentID: null,
  limit: 50,
  order: "desc",
});
const first = initial.data[0];
assert(first, "initial session");
assert(first.location.workspaceID, "gateway workspace translation");
assert(typeof first.time.created === "number", "encoded session timestamp");

const location = {
  directory: first.location.directory,
  workspace: first.location.workspaceID,
};
await Promise.all([
  gateway.agent.list({ location }),
  gateway.model.list({ location }),
  gateway.provider.list({ location }),
  gateway.command.list({ location }),
  gateway.skill.list({ location }),
  gateway.vcs.get({ location }),
]);

const repeated = await Promise.all(
  Array.from({ length: 10 }, () =>
    gateway.session.list({ parentID: null, limit: 50, order: "desc" }),
  ),
);
assert(
  repeated.every((response) =>
    response.data.some((session) => session.id === first.id),
  ),
  "stable aggregate reads",
);

const events = gateway.event.subscribe()[Symbol.asyncIterator]();
assert(
  (await nextEvent(events)).type === "server.connected",
  "gateway connected event",
);

const created = await upstream.session.create({
  location: { directory: first.location.directory },
});
const createdEvent = await waitForEvent(
  events,
  (event) =>
    event.type === "session.created" && event.data.sessionID === created.id,
);
if (createdEvent.type !== "session.created")
  throw new Error("Expected session.created");
assert(
  createdEvent.location?.workspaceID === first.location.workspaceID,
  "event workspace translation",
);
assert(
  createdEvent.data.location.workspaceID === first.location.workspaceID,
  "created event data translation",
);

const discovered = await gateway.session.get({ sessionID: created.id });
assert(
  discovered.location.workspaceID === first.location.workspaceID,
  "event registration before routing",
);

await gateway.session.rename({
  sessionID: created.id,
  title: "Gateway consistency check",
});
await waitForEvent(
  events,
  (event) =>
    event.type === "session.renamed" && event.data.sessionID === created.id,
);

const active = await gateway.session.active();
assert(
  typeof active === "object" && active !== null,
  "aggregate active sessions",
);

await gateway.session.remove({ sessionID: created.id });
await waitForEvent(
  events,
  (event) =>
    event.type === "session.deleted" && event.data.sessionID === created.id,
);
await events.return?.();

const afterDelete = await gateway.session.list({
  parentID: null,
  limit: 50,
  order: "desc",
});
assert(
  !afterDelete.data.some((session) => session.id === created.id),
  "deleted session removal",
);

console.log(
  JSON.stringify(
    {
      health: "passed",
      catalogs: "passed",
      aggregateReads: repeated.length,
      eventFanIn: "passed",
      eventRegistration: "passed",
      eventTranslation: "passed",
      sessionMutation: "passed",
      sessionDeletion: "passed",
    },
    undefined,
    2,
  ),
);

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Drive gateway check failed: ${label}`);
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
