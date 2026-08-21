# OpenCode Gateway

The gateway presents one OpenCode endpoint while routing each workspace to an OpenCode server in a Modal sandbox.

Agent, model, provider, integration, credential, plugin, configuration, and migration endpoints are served by the normal local OpenCode background service. Session, filesystem, VCS, shell, and PTY operations are routed to the owning sandbox.

## Prerequisites

Authenticate the Modal CLI and create the shared Volume v2 once:

```sh
modal volume create --version=2 opencode-gateway-workspaces-dev
```

Start and authenticate the normal local OpenCode service. The gateway uses it for catalogs, integrations, and credential snapshots:

```sh
opencode2 service start
```

## Start

From this repository:

```sh
export OPENCODE_GATEWAY_PASSWORD="choose-a-password"

export OPENCODE_GATEWAY_UPSTREAM_PASSWORD="sandbox-password"

bun run start -- \
  --hostname 127.0.0.1 \
  --port 4097 \
  --app opencode-gateway-dev \
  --volume opencode-gateway-workspaces-dev \
  --root /root \
  --opencode-version dev
```

Connect the full development TUI:

```sh
OPENCODE_PASSWORD="$OPENCODE_GATEWAY_PASSWORD" \
  opencode2 --server http://127.0.0.1:4097
```

The home screen reads its agent/model/provider/integration catalog from the local OpenCode control plane. Submitting the first prompt calls `POST /api/session`, which creates a workspace subpath and Modal sandbox, starts OpenCode, registers the initial session, and begins proxying its event stream.

On the home screen, `/cd` autocomplete lists gateway Images as virtual directories. The built-in Image is named `default`; selecting a named Image creates the next workspace from that Modal filesystem snapshot. Inside a workspace, OpenCode starts in `/root` and filesystem requests route to its Modal VM. OpenCode uses its normal root-user configuration, data, state, and cache locations; the gateway does not create `/persist/project` or `/persist/opencode`.

Each sandbox loads a direct, non-CodeMode tool named `gateway_image_snapshot`. Ask the agent to use it with an immutable name to retain the VM filesystem indefinitely as a reusable Image. The gateway receives the native tool event, creates the snapshot, records it in the catalog, and returns the result to the waiting tool. Snapshotting does not terminate the VM.

Session creation can also be called directly:

```sh
curl -u "opencode:$OPENCODE_GATEWAY_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{}' \
  http://127.0.0.1:4097/api/session
```

At gateway startup, complete credential rows are snapshotted from the local OpenCode database. Each new sandbox receives that snapshot through stdin. A temporary private OpenCode process initializes the current database schema, exits cleanly, and the gateway importer validates the credential table and inserts rows transactionally. Temporary payloads are deleted before the final OpenCode server starts. OAuth refresh tokens are retained because these are long-lived sessions and must refresh normally. The source database defaults to the normal local `opencode.db` and follows `OPENCODE_DB` when set.

The default sandbox image installs `@opencode-ai/cli@dev` globally with Bun. Override the base image with `--image` or pin another CLI version with `--opencode-version`. Sandboxes use Modal's full VM runtime with a fixed 1 GiB memory request and limit. The gateway asks a temporary `opencode2` process to initialize the database, then imports credentials with SQLite. Set `OPENCODE_GATEWAY_UPSTREAM_PASSWORD` when the sandbox OpenCode password should differ from the gateway password.

Gateway routing metadata is stored separately from sandbox OpenCode databases. The default local path is `~/.local/share/opencode-gateway/gateway.db`; override it with `--database`.
