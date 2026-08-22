export * as GatewayImage from "./image.js";

import path from "node:path";
import { Workspace } from "@opencode-ai/schema/workspace";

export const DefaultName = "default";
export const NamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SelectorPrefix = "wrk_image_";

export function validName(value: string) {
  return NamePattern.test(value);
}

export function select(directory: string | undefined, root: string) {
  if (!directory || path.resolve(directory) === path.resolve(root))
    return DefaultName;
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative.includes(path.sep) || !validName(relative)) return;
  return relative;
}

export function candidate(directory: string | undefined, root: string) {
  const selected = select(directory, root);
  if (selected) return selected;
  if (!directory) return DefaultName;
  const name = path.basename(path.resolve(directory));
  return validName(name) ? name : DefaultName;
}

export function directory(name: string, root: string) {
  return name === DefaultName ? path.resolve(root) : path.join(root, name);
}

export function workspace(name: string) {
  if (!validName(name)) throw new Error(`Invalid gateway image name: ${name}`);
  return Workspace.ID.make(SelectorPrefix + name);
}

export function fromWorkspace(workspaceID: string | undefined) {
  if (!workspaceID?.startsWith(SelectorPrefix)) return;
  const name = workspaceID.slice(SelectorPrefix.length);
  return validName(name) ? name : undefined;
}
