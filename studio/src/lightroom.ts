import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { maskKinds, maskLimits } from "./grading/masks.js";
import type { Lightroom, MaskCapabilities, MaskSlider, Photo } from "./types.js";
import { VERSION } from "./version.js";

export type LightroomUnknownCode = "timeout_unknown" | "disconnect_unknown" | "protocol_unknown";

export class LightroomOutcomeUnknown extends Error {
  constructor(readonly code: LightroomUnknownCode) {
    super("Lightroom 请求结果未知。若正在修改照片，请先在 Lightroom 中确认副本和快照状态，再决定是否恢复。");
  }
}

function unknownCode(code: unknown, message: string): LightroomUnknownCode | undefined {
  if (code === "timeout_unknown" || code === "disconnect_unknown" || code === "protocol_unknown") return code;
  // Another app can own the connection with an earlier bridge version.
  if (code !== undefined) return undefined;
  if (/^Plugin response timeout/i.test(message)) return "timeout_unknown";
  if (/^The Lightroom MCP process that owned the plugin connection exited during this call/i.test(message)) return "disconnect_unknown";
  return undefined;
}

export class LightroomClient implements Lightroom {
  private client = new Client({name:"lr-codex-studio",version:VERSION});
  constructor(private readonly serverEntry: string) {}
  async connect() {
    const env: Record<string, string> = {};
    // The SDK supplies the system environment. Only forward bridge settings and temp locations.
    for (const key of ["LIGHTROOM_MCP_REQUEST_PORT", "LIGHTROOM_MCP_RESPONSE_PORT", "LIGHTROOM_MCP_TOKEN_PATH", "TMP", "TMPDIR"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    await this.client.connect(new StdioClientTransport({command:process.execPath,args:[this.serverEntry],env:{...env,LIGHTROOM_MCP_TOOLSETS:"all",LIGHTROOM_MCP_READ_ONLY:"false"},maxBufferSize:16*1024*1024}));
  }
  async close() { await this.client.close(); }
  private async tools(signal?: AbortSignal) {
    let cursor: string | undefined;
    const tools = [];
    do {
      const page=await this.client.listTools(cursor ? {cursor} : {}, {signal});
      tools.push(...page.tools);
      cursor=page.nextCursor;
    } while(cursor);
    return new Map(tools.map(tool=>[tool.name,tool.inputSchema]));
  }
  async discover(signal?: AbortSignal): Promise<string[]> {
    const tools=await this.tools(signal);
    const missing=["get_selected_photos","get_photo_metadata","get_photo_preview","create_virtual_copies","create_develop_snapshot","apply_develop_snapshot","set_develop_settings"].filter(name=>!tools.has(name));
    const schema=tools.get("set_develop_settings") as {properties?:{settings?:{propertyNames?:{enum?:string[]}}}} | undefined;
    const keys=schema?.properties?.settings?.propertyNames?.enum;
    if(missing.length || !keys) throw new Error(`MCP capabilities missing: ${missing.join(", ") || "Develop setting schema"}`);
    return keys;
  }
  async discoverMasks(signal?: AbortSignal): Promise<MaskCapabilities> {
    const tools=await this.tools(signal);
    const create=tools.get("create_mask") as {properties?:{
      type?:{enum?:string[]}; adjustments?:{properties?:Record<string,{type?:string;minimum?:number;maximum?:number}>};
    }} | undefined;
    if (!tools.has("list_masks") || !tools.has("get_mask")) return {};
    const sliders: Partial<Record<MaskSlider,[number,number]>> = {};
    for (const key of Object.keys(maskLimits) as MaskSlider[]) {
      const slider=create?.properties?.adjustments?.properties?.[key];
      if (slider?.type!=="number" || typeof slider.minimum!=="number" || typeof slider.maximum!=="number") continue;
      const min=Math.max(slider.minimum,-maskLimits[key]),max=Math.min(slider.maximum,maskLimits[key]);
      if (min<=0 && max>=0 && min<max) sliders[key]=[min,max];
    }
    return Object.keys(sliders).length ? Object.fromEntries(maskKinds.filter(kind=>create?.properties?.type?.enum?.includes(kind)).map(kind=>[kind,sliders])) : {};
  }
  private async result(name: string,args: Record<string,unknown>,signal?: AbortSignal) {
    const response=await this.client.callTool({name,arguments:args},{timeout:360000,signal}).catch(() => {
      signal?.throwIfAborted();
      throw new LightroomOutcomeUnknown("disconnect_unknown");
    });
    if(response.isError) {
      const message=response.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
      const details=response.structuredContent;
      const code=unknownCode(details && typeof details==="object" && "code" in details ? details.code : undefined,message);
      if(code) throw new LightroomOutcomeUnknown(code);
      throw new Error(message);
    }
    return response;
  }
  async call(name: string,args: Record<string,unknown>,signal?: AbortSignal): Promise<Record<string,unknown>> {
    const result=await this.result(name,args,signal);
    const text=result.content.find(c=>c.type==="text");
    let data: unknown = result.structuredContent;
    try {
      if(data===undefined && text?.type==="text") data=JSON.parse(text.text);
    } catch {
      throw new LightroomOutcomeUnknown("protocol_unknown");
    }
    if(!data || typeof data!=="object" || Array.isArray(data)) throw new LightroomOutcomeUnknown("protocol_unknown");
    if((data as Record<string,unknown>).success===false) throw new Error(`Lightroom operation failed: ${name}`);
    return data as Record<string,unknown>;
  }
  async selected(signal?: AbortSignal) {
    const result=await this.call("get_selected_photos",{limit:2,include_path:true},signal);
    const photos=result.photos as {id:string|number}[];
    if(!Array.isArray(photos)) throw new Error("Unexpected selection response");
    // Selection is not silently reduced to the first photo.
    if(photos.length!==1 || (typeof result.total==="number" && result.total!==1)) throw new Error("Select exactly one Lightroom photo, or supply --photo ID");
    return photos;
  }
  async metadata(id: string|number, signal?: AbortSignal): Promise<Photo> {
    const photo=await this.call("get_photo_metadata",{photo_id:id,sections:["developSettings"]},signal);
    if(!photo.id || typeof photo.path!=="string" || !photo.developSettings) throw new Error("Photo metadata / Develop settings unavailable");
    return photo as unknown as Photo;
  }
  async preview(id: string|number, signal?: AbortSignal): Promise<Buffer> {
    const result=await this.result("get_photo_preview",{photo_id:id,size:"detail"},signal);
    const image=result.content.find(c=>c.type==="image");
    if(!image || image.type!=="image") throw new Error("Lightroom returned no rendered preview");
    return Buffer.from(image.data,"base64");
  }
}
