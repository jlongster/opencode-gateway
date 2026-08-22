import { expect, test } from "bun:test";
import { GatewayImage } from "../src/image";

test("selects default and named images from virtual directories", () => {
  const root = "/persist/project";
  expect(GatewayImage.select(undefined, root)).toBe("default");
  expect(GatewayImage.select(root, root)).toBe("default");
  expect(GatewayImage.select(`${root}/node-tools`, root)).toBe("node-tools");
  expect(GatewayImage.directory("node-tools", root)).toBe(`${root}/node-tools`);
  expect(String(GatewayImage.workspace("node-tools"))).toBe(
    "wrk_image_node-tools",
  );
  expect(GatewayImage.fromWorkspace("wrk_image_node-tools")).toBe("node-tools");
  expect(GatewayImage.fromWorkspace("wrk_real")).toBeUndefined();
});

test("rejects invalid and nested image selectors", () => {
  const root = "/persist/project";
  expect(GatewayImage.select(`${root}/UPPER`, root)).toBeUndefined();
  expect(GatewayImage.select(`${root}/one/two`, root)).toBeUndefined();
  expect(GatewayImage.select("/outside", root)).toBeUndefined();
  expect(GatewayImage.validName("a".repeat(65))).toBe(false);
  expect(
    GatewayImage.candidate("/root/projects/opencode-gateway/default", root),
  ).toBe("default");
});
