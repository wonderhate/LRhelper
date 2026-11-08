import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { maskKinds, maskLimits } from "./grading/masks.js";
import type { Lightroom, MaskCapabilities, MaskSlider, Photo } from "./types.js";
import { VERSION } from "./version.js";

export class LightroomClient implements Lightroom {
  private client = new Client({name:"lr-codex-studio",version:VERSION});
  constructor(private readonly serverEntry: string) {}
  async connect() {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string]=>typeof e[1]==="string"));
    await this.client.connect(new StdioClientTransport({command:process.execPath,args:[this.serverEntry],env:{...env,LIGHTROOM_MCP_TOOLSETS:"all",LIGHTROOM_MCP_READ_ONLY:"false"},maxBufferSize:16*1024*1024}));
  }
  async close() { await this.client.close(); }
  private async tools() {
    let cursor: string | undefined;
    const tools = [];
    do {
      const page=await this.client.listTools(cursor ? {cursor} : {});
      tools.push(...page.tools);
      cursor=page.nextCursor;
    } while(cursor);
    return new Map(tools.map(tool=>[tool.name,tool.inputSchema]));
  }
  async discover(): Promise<string[]> {
    const tools=await this.tools();
    const missing=["get_selected_photos","get_photo_metadata","get_photo_preview","create_virtual_copies","create_develop_snapshot","apply_develop_snapshot","set_develop_settings"].filter(name=>!tools.has(name));
    const schema=tools.get("set_develop_settings") as {properties?:{settings?:{propertyNames?:{enum?:string[]}}}} | undefined;
    const keys=schema?.properties?.settings?.propertyNames?.enum;
    if(missing.length || !keys) throw new Error(`MCP capabilities missing: ${missing.join(", ") || "Develop setting schema"}`);
    return keys;
  }
  async discoverMasks(): Promise<MaskCapabilities> {
    const tools=await this.tools();
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
  private async result(name: string,args: Record<string,unknown>) {
    const response=await this.client.callTool({name,arguments:args},{timeout:360000});
    if(response.isError) throw new Error(response.content.filter(c=>c.type==="text").map(c=>c.text).join("\n"));
    return response;
  }
  async call(name: string,args: Record<string,unknown>): Promise<Record<string,unknown>> {
    const result=await this.result(name,args);
    const text=result.content.find(c=>c.type==="text");
    const data=result.structuredContent ?? (text?.type==="text" ? JSON.parse(text.text) : undefined);
    if(!data || typeof data!=="object" || Array.isArray(data)) throw new Error(`Invalid MCP response: ${name}`);
    if((data as Record<string,unknown>).success===false) throw new Error(`Lightroom operation failed: ${name}`);
    return data as Record<string,unknown>;
  }
  async selected() {
    const result=await this.call("get_selected_photos",{limit:2,include_path:true});
    const photos=result.photos as {id:string|number}[];
    if(!Array.isArray(photos)) throw new Error("Unexpected selection response");
    // Selection is not silently reduced to the first photo.
    if(photos.length!==1 || (typeof result.total==="number" && result.total!==1)) throw new Error("Select exactly one Lightroom photo, or supply --photo ID");
    return photos;
  }
  async metadata(id: string|number): Promise<Photo> {
    const photo=await this.call("get_photo_metadata",{photo_id:id,sections:["developSettings"]});
    if(!photo.id || typeof photo.path!=="string" || !photo.developSettings) throw new Error("Photo metadata / Develop settings unavailable");
    return photo as unknown as Photo;
  }
  async preview(id: string|number): Promise<Buffer> {
    const result=await this.result("get_photo_preview",{photo_id:id,size:"detail"});
    const image=result.content.find(c=>c.type==="image");
    if(!image || image.type!=="image") throw new Error("Lightroom returned no rendered preview");
    return Buffer.from(image.data,"base64");
  }
}
