import { Plugin } from "@opencode-ai/plugin/tui";
import { onCleanup, onMount } from "solid-js";

function Commands(props: { context: Plugin.Context }) {
  const images = async () => {
    const server = (await props.context.client.server.get()) as {
      gateway?: { images?: Array<{ name: string }> };
    };
    return server.gateway?.images ?? [];
  };
  const location = (name: string) =>
    props.context.client.location.get({
      location: { directory: name === "default" ? "/root" : `/root/${name}` },
    } as never);

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
      const selected = await location("default");
      props.context.ui.router.navigate({
        type: "home",
        location: selected,
      } as never);
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
          const selected = await location(name);
          props.context.ui.router.navigate({
            type: "home",
            location: selected,
          } as never);
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
