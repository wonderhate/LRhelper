export interface ToolProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ToolProgress) => void;
}

export interface PluginResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export type BridgeFailureCode = "not_sent" | "cancelled" | "timeout_unknown" | "disconnect_unknown" | "protocol_unknown";

export class BridgeFailure extends Error {
  constructor(readonly code: BridgeFailureCode, message: string) {
    super(message);
  }
}

const disconnected = () => new BridgeFailure("disconnect_unknown",
  "Lightroom connection closed during the request. Its result is unknown. Check Lightroom before retrying a write.");

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProgress(value: unknown): value is ToolProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { progress, total, message } = value as Record<string, unknown>;
  return isCount(progress) && (total === undefined || (isCount(total) && total >= progress))
    && (message === undefined || typeof message === "string");
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^req_\d{1,16}_\d{1,16}$/.test(value);
}

interface PendingResponse {
  resolve: (resp: PluginResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (progress: ToolProgress) => void;
  cleanup: () => void;
}

export interface DispatcherOptions {
  send: (line: string) => boolean;
  getToken: () => string;
  timeoutMs?: number;
  /**
   * Per-action timeout overrides (ms), keyed by action name. Long-running
   * actions like batch export/import need far more than the default before a
   * healthy plugin can reply; with too short a timeout the call reports a
   * false failure, and the plugin's eventual (correct) response arrives after
   * the pending entry is gone, so it is dropped as an unknown id. Actions
   * absent here -- or mapped to a non-positive value -- use `timeoutMs`.
   */
  actionTimeoutsMs?: Record<string, number>;
  log?: (msg: string) => void;
}

export class Dispatcher {
  private pending = new Map<string, PendingResponse>();
  private idCounter = 0;
  private readonly timeoutMs: number;
  private readonly actionTimeoutsMs: Record<string, number>;
  private readonly send: (line: string) => boolean;
  private readonly getToken: () => string;
  private readonly log: (msg: string) => void;

  constructor(opts: DispatcherOptions) {
    this.send = opts.send;
    this.getToken = opts.getToken;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.actionTimeoutsMs = opts.actionTimeoutsMs ?? {};
    this.log = opts.log ?? ((msg: string) => console.error(msg));
  }

  handleResponseLine(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.rejectMalformed("Bad JSON from plugin");
      return;
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      this.rejectMalformed("Invalid response envelope from plugin");
      return;
    }
    const frame = decoded as Record<string, unknown>;
    if ("progressFor" in frame || "progress" in frame) {
      if (!isRequestId(frame.progressFor) || !isProgress(frame.progress) ||
          "id" in frame || "result" in frame || "error" in frame) {
        this.rejectMalformed("Invalid progress envelope from plugin", frame.progressFor);
        return;
      }
      this.pending.get(frame.progressFor)?.onProgress?.(frame.progress);
      return;
    }
    if (!isRequestId(frame.id)) {
      this.rejectMalformed("Response for unknown id or invalid id from plugin");
      return;
    }
    const hasResult = Object.hasOwn(frame, "result");
    const hasError = Object.hasOwn(frame, "error");
    if (hasResult === hasError || (hasError && (typeof frame.error !== "string" || !frame.error.trim()))) {
      this.rejectMalformed("Invalid result envelope from plugin", frame.id);
      return;
    }
    const pending = this.takePending(frame.id);
    if (!pending) {
      this.log("Response for unknown id from plugin");
      return;
    }
    pending.resolve(hasError ? { id: frame.id, error: frame.error as string } : { id: frame.id, result: frame.result });
  }

  private takePending(id: string): PendingResponse | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.cleanup();
    }
    return pending;
  }

  private rejectMalformed(description: string, id?: unknown): void {
    this.log(description);
    const error = new BridgeFailure("protocol_unknown", "Invalid Lightroom response. The request result is unknown.");
    if (isRequestId(id)) this.takePending(id)?.reject(error);
    else this.rejectAll(error);
  }

  rejectAll(error: BridgeFailure = disconnected()): void {
    for (const id of this.pending.keys()) this.takePending(id)?.reject(error);
  }

  async call(action: string, params: unknown, timeoutOverrideMs?: number, options?: CallOptions): Promise<PluginResponse> {
    const id = `req_${Date.now()}_${this.idCounter++}`;
    // A non-positive override means "no override": `0` would otherwise arm a
    // 0 ms timer that rejects on the next tick.
    const override = timeoutOverrideMs ?? this.actionTimeoutsMs[action];
    const timeoutMs = override !== undefined && override > 0 ? override : this.timeoutMs;

    if (options?.signal?.aborted) throw new BridgeFailure("cancelled", "Request cancelled before sending");
    let payload: string;
    try {
      payload = JSON.stringify({ hello: this.getToken(), id, action, params: params ?? {}, reportProgress: Boolean(options?.onProgress) });
    } catch {
      throw new BridgeFailure("not_sent", "Could not prepare the request to Lightroom");
    }
    const cancel = () => {
      if (this.pending.has(id)) {
        try {
          this.send(JSON.stringify({ hello: this.getToken(), action: "cancel", params: { request_id: id } }));
        } catch {
          this.log("Could not send Lightroom cancellation request");
        }
      }
    };
    return new Promise<PluginResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.takePending(id)?.reject(new BridgeFailure("timeout_unknown",
          `Plugin response timeout (${timeoutMs / 1000}s). The request result is unknown.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, onProgress: options?.onProgress,
        cleanup: () => options?.signal?.removeEventListener("abort", cancel) });
      options?.signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (!this.send(payload)) this.takePending(id)?.reject(new BridgeFailure("not_sent",
          "Failed to send request to plugin (socket dropped)"));
      } catch {
        this.takePending(id)?.reject(disconnected());
      }
    });
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
