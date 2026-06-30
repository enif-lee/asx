// ASX Proxy — hub-and-spoke transcoder types.
//
//   agent wire ──parse──▶ COMMON ──build──▶ backend wire
//   agent wire ◀─format── COMMON ◀─parse─── backend wire
//
// Every adapter only knows its own wire <-> COMMON. N adapters, not N*N converters.

export interface CommonMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface CommonRequest {
  model: string;          // model the agent asked for (backend usually maps to its own)
  system?: string;        // system prompt / instructions
  messages: CommonMessage[];
  tools?: any[];          // raw agent tools (passthrough; not translated in M1)
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

export type CommonEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string };

export interface CommonResponse {
  text: string;
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
}

// Provider acting as the BACKEND (the real upstream the proxy calls).
export interface BackendAdapter {
  // Build the upstream HTTP call from COMMON + the profile credential (raw stored secret).
  buildRequest(req: CommonRequest, cred: string): { url: string; headers: Record<string, string>; body: string };
  // Parse one upstream SSE event block into COMMON events.
  parseStreamChunk(eventBlock: string): CommonEvent[];
  // Parse a non-stream upstream response into COMMON.
  parseResponse(json: any): CommonResponse;
}

export interface StreamCtx {
  id: string;
  created: number;
  model: string;
  first: boolean;
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
export interface TargetCred {
  apiKey?: string;
  raw?: string;
  type: 'anthropic' | 'openai' | 'codex-oauth' | 'key';
}
