import { expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { BRIDGE_CAPABILITY_HASH, BRIDGE_PRODUCT, BRIDGE_PROTOCOL, UPDATE_BRIDGE_MESSAGE, isCompatiblePlugin } from "../src/bridge-identity.js";
import { createCallToolHandler } from "../src/tool-handler.js";
import { VERSION } from "../src/version.js";

const result = {
  pong: true, product: BRIDGE_PRODUCT, protocol: BRIDGE_PROTOCOL,
  plugin_version: VERSION, capability_hash: BRIDGE_CAPABILITY_HASH,
};

it("agrees with the bundled Lightroom plugin identity", () => {
  const lua = readFileSync("../plugin/LightroomMCP.lrplugin/BridgeIdentity.lua", "utf8");
  expect(lua).toContain(`product = "${BRIDGE_PRODUCT}"`);
  expect(lua).toContain(`protocol = ${BRIDGE_PROTOCOL}`);
  expect(lua).toContain(BRIDGE_CAPABILITY_HASH);
  expect(isCompatiblePlugin({ result })).toBe(true);
});

it.each([
  { pong: true },
  { ...result, product: "other/fork" },
  { ...result, protocol: 2 },
  { ...result, plugin_version: "0.25.0" },
  { ...result, capability_hash: "outdated" },
])("blocks writes with an unrecognized plugin (%p)", async reply => {
  const call = jest.fn(async () => ({ id: "test", result: { count: 0 } }));
  const handler = createCallToolHandler({
    dispatcher: { call },
    isReady: () => true,
    checkCompatibility: name => name === "set_develop_settings" && !isCompatiblePlugin({ result: reply })
      ? UPDATE_BRIDGE_MESSAGE : undefined,
  });
  const blocked = await handler("set_develop_settings", { photo_id: 1, settings: { Exposure2012: 0.1 } });
  expect(blocked.structuredContent).toEqual({ code: "not_sent" });
  expect(blocked.content[0].text).toBe(UPDATE_BRIDGE_MESSAGE);
  expect(call).not.toHaveBeenCalled();
  expect((await handler("list_collections", {})).isError).toBeUndefined();
});
