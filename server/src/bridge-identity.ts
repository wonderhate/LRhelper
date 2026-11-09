import { VERSION } from "./version.js";

export const BRIDGE_PRODUCT = "wonderhate/LRhelper";
export const BRIDGE_PROTOCOL = 1;
// Fingerprint of the guarded catalog identity, copy name, frame, snapshot and error semantics.
export const BRIDGE_CAPABILITY_HASH = "1032980ce42e443aacbbcfc5ba9dbb86f215789b21bc201cb54074365241e96d";

export const UPDATE_BRIDGE_MESSAGE =
  "The loaded Lightroom MCP plugin is incompatible with LRhelper. Add the bundled LightroomMCP.lrplugin in Plug-in Manager, disable the old copy, and restart Lightroom.";
export const UPDATE_OWNER_MESSAGE =
  "An older Lightroom MCP process owns the connection. Close the client that started it, then restart the LRhelper Host.";

export function isCompatiblePlugin(reply: unknown): boolean {
  if (!reply || typeof reply !== "object") return false;
  const result = (reply as { result?: unknown }).result;
  if (!result || typeof result !== "object") return false;
  const identity = result as Record<string, unknown>;
  return identity.pong === true && identity.product === BRIDGE_PRODUCT &&
    identity.plugin_version === VERSION && identity.protocol === BRIDGE_PROTOCOL &&
    identity.capability_hash === BRIDGE_CAPABILITY_HASH;
}
