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
  --root /persist/project \
  --repository https://github.com/anomalyco/opencode.git \
  --branch v2
```

Connect the full development TUI:

```sh
OPENCODE_PASSWORD="$OPENCODE_GATEWAY_PASSWORD" \
  opencode2 --server http://127.0.0.1:4097
```

The home screen reads its agent/model/provider/integration catalog from the local OpenCode control plane. Submitting the first prompt calls `POST /api/session`, which creates a workspace subpath and Modal sandbox, starts OpenCode, registers the initial session, and begins proxying its event stream.

Session creation can also be called directly:

```sh
curl -u "opencode:$OPENCODE_GATEWAY_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{}' \
  http://127.0.0.1:4097/api/session
```

At gateway startup, complete credential rows are snapshotted from the local OpenCode database. Each new sandbox receives that snapshot through stdin. A temporary private OpenCode process initializes the current database schema, exits cleanly, and the gateway importer validates the credential table and inserts rows transactionally. Temporary payloads are deleted before the final OpenCode server starts. OAuth refresh tokens are retained because these are long-lived sessions and must refresh normally. The source database defaults to the normal local `opencode.db` and follows `OPENCODE_DB` when set.

The default sandbox image builds the current V2 source checkout. Override it with `--image`, `--repository`, or `--branch`. The gateway does not import Core from that checkout: it asks the temporary OpenCode process to initialize the database, then imports credentials with SQLite. Set `OPENCODE_GATEWAY_UPSTREAM_PASSWORD` when the sandbox OpenCode password should differ from the gateway password.

Gateway routing metadata is stored separately from sandbox OpenCode databases. The default local path is `~/.local/share/opencode-gateway/gateway.db`; override it with `--database`.
