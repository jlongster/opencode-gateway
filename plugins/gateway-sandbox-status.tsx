/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui";
import { onCleanup } from "solid-js";

function CreatingSandbox() {
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text>Creating sandbox...</text>
    </box>
  );
}

function SandboxStatus(props: { context: Plugin.Context }) {
  const session = props.context.client.session;
  const original = session.create;

  const create: typeof original = async (...args) => {
    props.context.ui.dialog.show(() => <CreatingSandbox />);
    props.context.ui.dialog.set({ size: "medium", centered: true });
    try {
      return await original(...args);
    } finally {
      props.context.ui.dialog.clear();
    }
  };

  session.create = create;
  onCleanup(() => {
    if (session.create === create) session.create = original;
  });

  return null;
}

export default Plugin.define({
  id: "gateway.sandbox-status",
  setup(context) {
    context.ui.slot({
      append: "app",
      render: () => <SandboxStatus context={context} />,
    });
  },
});
