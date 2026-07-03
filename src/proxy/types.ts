// ASX Proxy — hub-and-spoke transcoder types.
//
//   agent wire ──parse──▶ COMMON ──build──▶ backend wire
//   agent wire ◀─format── COMMON ◀─parse─── backend wire
//
// Every adapter only knows its own wire <-> COMMON. N adapters, not N*N converters.

// A single tool the model may call. `arguments` is the raw JSON string of args
// (kept as a string so it round-trips losslessly across wire formats).
export interface CommonToolCall {
  id: string;            // provider correlation id (Anthropic tool_use id / Responses call_id / chat tool_call id)
  name: string;
  arguments: string;
}

export interface CommonMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // assistant turns may carry the tool calls the model requested this turn.
  toolCalls?: CommonToolCall[];
  // tool turns carry the result of a prior call; toolCallId links back to it.
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;     // tool turns: the tool execution failed (Anthropic tool_result.is_error)
}

// A tool the agent exposes to the model, normalized to name + JSON-schema params.
export interface CommonToolDef {
  name: string;
  description?: string;
  parameters?: any;      // JSON schema object
  strict?: boolean;      // strict structured-args enforcement (OpenAI/Chat)
  builtinType?: string;  // provider built-in tool type passthrough (e.g. Anthropic 'bash_20250124')
}

export interface CommonRequest {
  model: string;          // model the agent asked for (backend usually maps to its own)
  system?: string;        // system prompt / instructions
  messages: CommonMessage[];
  tools?: CommonToolDef[]; // normalized tool definitions (translated across wires)
  // Codex namespace tool groups (e.g. 'multi_agent_v1') flattened into `${ns}__${name}` defs;
  // the response side needs this list to split flat names back into namespaced calls.
  toolNamespaces?: string[];
  toolChoice?: any;        // pass-through hint ('auto' | 'none' | 'required' | {name})
  parallelToolCalls?: boolean; // allow the model to emit multiple tool calls per turn
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

// Events flow backend -> COMMON -> agent.
//   - Backends emit `text`, `tool_call_delta` (fragments), `done`, `error`.
//   - The proxy server accumulates `tool_call_delta` by index into a complete
//     `tool_call` event, which is what agent adapters consume.
export type CommonEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string };

export interface CommonResponse {
  text: string;
  toolCalls?: CommonToolCall[];
  finishReason?: string;
}

// Provider acting as the AGENT (the binary talking TO the proxy).
export interface AgentAdapter {
  // Parse an incoming inference request into COMMON.
  parseRequest(path: string, body: any): CommonRequest;
  // HTTP headers for a streaming response.
  streamHeaders(): Record<string, string>;
  // Turn one COMMON event into wire SSE text (may be '' for ignored events).
  // `ctx` persists across the response (id/created/model, first-chunk flag).
  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string;
  // Non-stream: full wire response body.
  formatResponse(resp: CommonResponse, req: CommonRequest): any;
  // GET /models body in this agent's wire format (drives its `/model` picker). Each choice is
  // a backend model the proxy exposes; the agent frames it however its CLI expects.
  formatModels(choices: Array<{ id: string; model: string; effort?: string }>): any;
}

// Provider acting as the BACKEND (the real upstream the proxy calls).
export interface BackendAdapter {
  // Build the upstream HTTP call from COMMON + the profile credential (raw stored secret).
  buildRequest(req: CommonRequest, cred: string): { url: string; headers: Record<string, string>; body: string };
  // Parse one upstream SSE event block into COMMON events.
  parseStreamChunk(eventBlock: string): CommonEvent[];
  // Provider-specific retry decision from a non-stream response (e.g. z.ai returns a 200 whose
  // body carries {"error":{"code":"1305"}} on overload). The server already retries generic
  // transport failures (network errors, 429/5xx); this only adds per-provider body cases.
  isRetryable?(status: number, body: string): boolean;
}

export interface StreamCtx {
  id: string;
  created: number;
  model: string;
  first: boolean;
  acc?: string;      // accumulated text (for adapters that need the full text at 'done')
  itemId?: string;   // stable output item id (Responses wire)
  textOpen?: boolean;    // agent has opened its text block/item
  textIndex?: number;    // output/content index reserved for streamed text
  nextIndex?: number;    // next free output index (text item + one per tool call)
  items?: any[];         // wire output items assembled so far (for final framing)
  toolNamespaces?: string[]; // from CommonRequest — split `${ns}__${name}` back into namespaced calls
}

export interface ProxyStartOptions {
  sourceProvider: string;   // agent (binary)
  targetProvider: string;   // backend (profile)
  targetCredential: { raw?: string; apiKey?: string };
  tmpDir?: string;
  port?: number;
}

export interface ProxyHandle {
  url: string;
  port: number;
  stop: () => void;
}

// kept for back-compat with cli.ts cred shape
