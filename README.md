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

## Install the TUI plugins

Install the gateway TUI plugins on each machine that connects to the gateway:

```sh
cp plugins/gateway-image.ts ~/.config/opencode/gateway-image.ts
cp plugins/gateway-sandbox-status.tsx ~/.config/opencode/gateway-sandbox-status.tsx
```

Add them to the `plugins` array in `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    "/home/you/.config/opencode/gateway-image.ts",
    "/home/you/.config/opencode/gateway-sandbox-status.tsx"
  ]
}
```

Use the absolute path to your home directory; OpenCode does not expand `~` in plugin paths. Restart the TUI after installing them. The Image plugin queries the connected server, selects its default gateway Image on the home screen, and adds the `/image` command for selecting named Images. The sandbox status plugin displays a dialog while the first session request provisions its sandbox.

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

## Connect from sandboxes through OpenTunnel

To let gateway sandboxes call the gateway without opening an inbound port on the gateway host, create a persistent [OpenTunnel](https://opentunnel.xyz) route to the local listener:

```sh
bun install -g @opentunnel/cli
opentunnel --profile opencode-gateway create
opentunnel --profile opencode-gateway route add gateway 127.0.0.1:4097
opentunnel --profile opencode-gateway serve
```

Run `opentunnel serve` under the host's service manager. Set the generated route URL before starting the gateway:

```sh
export OPENCODE_GATEWAY_URL="https://gateway.TUNNEL_ID.opentunnel.xyz"
```

The gateway injects that URL and `OPENCODE_GATEWAY_PASSWORD` into every new or resumed sandbox. From a sandbox, route a request to another workspace with:

```sh
OPENCODE_PASSWORD="$OPENCODE_GATEWAY_PASSWORD" \
  opencode2 api \
    --server "$OPENCODE_GATEWAY_URL" \
    --header "x-opencode-workspace:$TARGET_WORKSPACE_ID" \
    get /api/location
```

Already-running sandboxes must be restarted before they receive newly configured environment variables.

The root-config `/image` command lists gateway Images and their descriptions in a searchable picker. The built-in Image is named `default`; selecting a named Image creates the next workspace from that Modal filesystem snapshot. Inside a workspace, OpenCode starts in `/root` and filesystem requests route to its Modal VM. Project files, configuration, cache, and other VM state are ephemeral unless captured in a named filesystem snapshot. Only `opencode.db` is persisted, at `/opencode/opencode.db` on the workspace's Volume subpath. Deleting the session deletes that database and terminates its sandbox.

Each sandbox loads two direct, non-CodeMode gateway tools. `gateway_image_snapshot` requires an immutable name and a description of the image's contents and intended use. `gateway_image_list` returns the available images with those descriptions. The gateway receives each native tool event, performs the operation, records its durable result, and returns it to the waiting tool. Snapshotting does not terminate the VM. Sandboxes create sessions through the gateway's normal OpenCode API.

Session creation can also be called directly:

```sh
curl -u "opencode:$OPENCODE_GATEWAY_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{}' \
  http://127.0.0.1:4097/api/session
```

At gateway startup, complete credential rows are snapshotted from the local OpenCode database. Each new sandbox receives that snapshot through stdin. A temporary private OpenCode process initializes the current database schema, exits cleanly, and the gateway importer validates the credential table and inserts rows transactionally. Temporary payloads are deleted before the final OpenCode server starts. OAuth refresh tokens are retained because these are long-lived sessions and must refresh normally. The source database defaults to the normal local `opencode.db` and follows `OPENCODE_DB` when set.

The default sandbox image installs `@opencode-ai/cli@dev` globally with Bun. Override the base image with `--image` or pin another CLI version with `--opencode-version`. Sandboxes use Modal's full VM runtime with a fixed 1 GiB memory request and limit and a one-minute idle timeout. The gateway asks a temporary `opencode2` process to initialize the database, then imports credentials with SQLite. Set `OPENCODE_GATEWAY_UPSTREAM_PASSWORD` when the sandbox OpenCode password should differ from the gateway password.

Gateway routing metadata is stored separately from sandbox OpenCode databases. The default local path is `~/.local/share/opencode-gateway/gateway.db`; override it with `--database`.
