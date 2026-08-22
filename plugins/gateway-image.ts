import { Plugin } from "@opencode-ai/plugin/tui";
import { onCleanup, onMount } from "solid-js";

function Commands(props: { context: Plugin.Context }) {
  const baseURL =
    typeof props.context.options.baseURL === "string"
      ? props.context.options.baseURL
      : "http://127.0.0.1:4097";
  const password = process.env.OPENCODE_PASSWORD;
  const request = async <Value>(pathname: string) => {
    const response = await fetch(new URL(pathname, baseURL), {
      headers: password
        ? { authorization: `Basic ${btoa(`opencode:${password}`)}` }
        : undefined,
    });
    if (!response.ok)
      throw new Error(
        `Gateway request failed: ${response.status} ${await response.text()}`,
      );
    return (await response.json()) as Value;
  };

  let selecting = false;
  const ensureHomeImage = async () => {
    const route = props.context.ui.router.current() as {
      type: string;
      location?: { directory: string; workspaceID?: string };
    };
    const selected =
      route.location?.directory === "/root" ||
      /^\/root\/[^/]+$/.test(route.location?.directory ?? "");
    if (
      route.type !== "home" ||
      route.location?.workspaceID ||
      selected ||
      selecting
    )
      return;
    selecting = true;
    try {
      const location = await request<{
        directory: string;
        project: { id: string; directory: string; canonical: string };
      }>("/api/gateway/image/default");
      props.context.ui.router.navigate({ type: "home", location } as never);
    } finally {
      selecting = false;
    }
  };
  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    const run = () => void ensureHomeImage().catch(() => undefined);
    run();
    timer = setInterval(run, 100);
  });
  onCleanup(() => clearInterval(timer));

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
          const images = await request<{ data: Array<{ name: string }> }>(
            "/api/gateway/image",
          );
          const name = await props.context.ui.dialog.select({
            title: "Select gateway image",
            placeholder: "Search images",
            options: images.data.map((image) => ({
              title: image.name,
              value: image.name,
            })),
          });
          if (!name) return;
          const location = await request<{
            directory: string;
            project: { id: string; directory: string; canonical: string };
          }>(`/api/gateway/image/${encodeURIComponent(name)}`);
          props.context.ui.router.navigate({ type: "home", location } as never);
          props.context.ui.toast.show({
            message: `Selected gateway image: ${name}`,
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
