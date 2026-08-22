import { expect, test } from "bun:test";
import { GatewayIcon } from "../src/icon";

test("assigns a stable text symbol to each workspace", () => {
  const first = GatewayIcon.workspace("wrk_first");
  expect(GatewayIcon.workspace("wrk_first")).toBe(first);
  expect(GatewayIcon.workspace("wrk_second")).not.toBe(first);
  expect(first).toMatch(/^\P{Emoji_Presentation}$/u);
});
