import path from "node:path";
import { Codex, type CodexOptions, type UserInput } from "@openai/codex-sdk";
import { gradingPrompt } from "./grading/prompt.js";
import { planSchema } from "./grading/validator.js";
import { prepareCodexRuntime } from "./runtime-isolation.js";
import type { ModelRuntime } from "./types.js";

export class CodexRuntime implements ModelRuntime {
  constructor(
    private readonly createCodex: (options: CodexOptions)=>Pick<Codex,"startThread"> = options=>new Codex(options),
    private readonly prepare: ()=>Promise<CodexOptions> = prepareCodexRuntime,
  ) {}
  async generate(input: Parameters<ModelRuntime["generate"]>[0]) {
    input.signal?.throwIfAborted();
    const options = await this.prepare();
    input.signal?.throwIfAborted();
    const codex=this.createCodex(options);
    const thread=codex.startThread({
      workingDirectory:path.dirname(input.targetImage),skipGitRepoCheck:true,
      sandboxMode:"read-only",approvalPolicy:"never",webSearchMode:"disabled",networkAccessEnabled:false,
      ...(process.env.STUDIO_CODEX_MODEL ? {model:process.env.STUDIO_CODEX_MODEL} : {}),
    });
    // Each revision replays its selected lineage into a fresh isolated SDK thread.
    // Resuming a shared mutable thread would leak later turns into an older branch.
    const content: UserInput[]=[{type:"text",text:gradingPrompt(input.request,input.baseline,input.keys,input.history,input.maskCapabilities,input.previousMasks)},{type:"local_image",path:input.targetImage}];
    if(input.request.mode === "reference" && input.referenceImage) content.push({type:"local_image",path:input.referenceImage});
    const signal=AbortSignal.any([AbortSignal.timeout(180000),...(input.signal ? [input.signal] : [])]);
    const {events}=await thread.runStreamed(content,{outputSchema:planSchema(input.keys,input.maskCapabilities),signal});
    let finalResponse="";
    for await(const event of events) {
      if(event.type==="turn.failed") throw new Error(event.error.message);
      if(event.type==="error") {
        if (/^Reconnecting\.\.\. \d+\/\d+/.test(event.message)) {
          process.stderr.write("Codex 连接中断，正在重试…\n");
          continue;
        }
        throw new Error(event.message);
      }
      if(event.type==="item.completed" && event.item.type==="agent_message") finalResponse=event.item.text;
      if(event.type==="turn.started") process.stderr.write("Codex 正在分析照片…\n");
    }
    if(!finalResponse) throw new Error("Codex returned no grading plan");
    return {plan:JSON.parse(finalResponse) as unknown,threadId:thread.id ?? undefined};
  }
}
