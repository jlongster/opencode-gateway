import { Plugin } from "@opencode-ai/plugin/tui";

function Commands(props: { context: Plugin.Context }) {
  const server = props.context.client.server.get() as Promise<{
    urls: string[];
    gateway?: { images?: Array<{ name: string }> };
  }>;
  const images = async () => {
    const connection = await server;
    return connection.gateway?.images ?? [];
  };
  const create = async (name: string) => {
    const connection = await server;
    const baseURL = connection.urls[0];
    if (!baseURL) throw new Error("Connected server did not report a URL");
    const password = process.env.OPENCODE_PASSWORD;
    const response = await fetch(
      new URL(
        `/api/gateway/image/${encodeURIComponent(name)}/session`,
        baseURL,
      ),
      {
        method: "POST",
        headers: password
          ? { authorization: `Basic ${btoa(`opencode:${password}`)}` }
          : undefined,
      },
    );
    if (!response.ok)
      throw new Error(
        `Gateway request failed: ${response.status} ${await response.text()}`,
      );
    return (await response.json()) as {
      data: { id: string };
    };
  };

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "gateway.image.select",
        title: "Select gateway image",
        group: "Gateway",
        palette: true,
        slash: { name: "image" },
        enabled: () => props.context.ui.router.current().type === "home",
        run: async () => {
          const available = await images();
          const name = await props.context.ui.dialog.select({
            title: "Select gateway image",
            placeholder: "Search images",
            options: available.map((image) => ({
              title: image.name,
              value: image.name,
            })),
          });
          if (!name) return;
          const session = await create(name);
          props.context.ui.router.navigate({
            type: "session",
            sessionID: session.data.id,
          });
          props.context.ui.toast.show({
            message: `Created session from gateway image: ${name}`,
            variant: "success",
          });
        },
      },
    ],
  }));
  return null;
}

export default Plugin.define({
  id: "gateway.image",
  setup(context) {
    context.ui.slot({
      append: "app",
      render: () => Commands({ context }),
    });
  },
});
