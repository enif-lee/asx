# ASX Proxy (Local LLM API Gateway) 구현 계획

**작성일**: 2026-06-30
**목적**: `asx <profile> <target-provider> <prompt>` 형태로 cross-provider 실행을 지원하는 Local LLM API Gateway(Proxy) 컨셉 도입.
**핵심 아이디어**: input schema → internal common data format → external schema 변환기만 구현하면 자유롭게 조합/확장 가능.

---

## 1. 배경 및 요구사항

### 현재 ASX 상태 (exec 중심)
- `asx e <name>` (alias `exec`): 프로필에 따라 native 바이너리(claude/codex/grok) 격리 실행.
  - profile provider에 맞는 HOME 오버라이드 (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`).
  - temp dir에 credential 복사 (isolation).
  - 현재 활성 프로필과 일치하면 직접 실행 (최적화).
  - `-b/--bypass`: provider별 위험 플래그 자동 주입.
- Provider별 credential: codex(`~/.codex/auth.json`), claude (mac keychain + file), grok(`~/.grok/auth.json`), key형 (XAI/ZAI env or file).
- `asx list`는 live system credential과 비교 표시.

### 신규 스펙
- 명령: `asx ed.codex claude <prompt>`
  - `ed.codex` 프로필의 provider (`codex`)와 지정 provider (`claude`)가 다르면 **ASX Proxy 경유**.
  - 일치하면 기존 direct exec 경로.
- 방향성: grok/codex/claude → ASX Proxy → grok/codex/claude/xai/zai (및 기타 OpenAI/Anthropic compat).
- Proxy 핵심: **중간 transformer만 추가**하면 새로운 source↔target 조합이 자동 지원.
- 각 native tool의 endpoint override 설정을 활용 (env 또는 config injection).

---

## 2. 리서치 분석 요약

### 2.1 opencodex 핵심 구조 (가장 중요한 참조)
- **위치**: `/Users/ed/personal/opencodex`
- **Internal Common Format**: `OcxParsedRequest` (Zod 스키마)
  - `responsesRequestSchema` 기반 (OpenAI Responses API 스타일).
  - `input` (items: message/reasoning/function_call/...), `tools`, `reasoning`, `instructions`, `previous_response_id` 등.
  - `_rawBody`, `_webSearch` 등의 내부 확장 필드.
- **ProviderAdapter** (`src/adapters/base.ts`)
  ```ts
  interface ProviderAdapter {
    buildRequest(parsed: OcxParsedRequest): AdapterRequest | Promise<...>  // {url, method, headers, body}
    parseStream(resp: Response): AsyncGenerator<AdapterEvent>
    parseResponse?(resp): Promise<AdapterEvent[]>
  }
  ```
- **AdapterEvent**: `text_delta`, `tool_call`, `reasoning`, `usage`, `error` 등.
- **구현 예**:
  - `openai-responses.ts`: passthrough (ChatGPT OAuth forward 포함, FORWARD_HEADERS).
  - `anthropic.ts`: Responses → Anthropic Messages 변환 (thinking budget 계산, tool prefix, cache tokens 등 복잡한 매핑).
  - `openai-chat.ts`: chat.completions 포맷 (system→user/developer, reasoning_content 보존 옵션, bracket suffix strip for zai).
- **Router** (`src/router.ts`): model prefix, defaultProvider, explicit `provider/model` 로 provider 선택 + registry 병합.
- **Codex Config Injection** (`src/codex-inject.ts`): 
  - `config.toml`에 `[model_providers.<id>] base_url=... wire_api="responses" requires_openai_auth=true` 주입.
  - `model_provider = "opencodex"` root key.
  - Profile 파일 별도 생성 (`codex --profile`).
  - idempotent strip/restore 지원.
- **장점**: Codex(Responses) 입력을 받아 다양한 백엔드로 라우팅. transformer만 추가하면 확장 용이.
- **스트리밍/도구/사고**: parseStream에서 이벤트 단위로 변환 → Codex가 이해하는 포맷으로 재조립.

### 2.2 openclaude 핵심 구조
- **위치**: `/Users/ed/personal/openclaude`
- **기본 wire**: Anthropic Messages (Claude Code 네이티브).
- **Shim 시스템** (`src/services/api/openaiShim.ts`, `codexShim.ts`, `providerConfig.ts`)
  - `CLAUDE_CODE_USE_OPENAI=1` + `OPENAI_BASE_URL` → OpenAI chat/responses 포맷으로 번역 후 다시 Anthropic stream 이벤트로 변환.
  - `resolveProviderRequest`: `OPENAI_BASE_URL`, `MISTRAL_BASE_URL`, `GEMINI_BASE_URL`, `CLINE_API_KEY` 등을 해석하여 transport/chat_completions|responses 결정.
  - 많은 third-party (Ollama, OpenRouter, DeepSeek, xAI, Z.ai 등) 지원.
- **Endpoint 상수** (`providerConfig.ts`):
  - `DEFAULT_OPENAI_BASE_URL`, `DEFAULT_CODEX_BASE_URL`, `DEFAULT_MISTRAL...`
- **주요 패턴**: env 기반 라우팅 + shimConfig (removeBodyFields, idle timeout, think tag filter 등).
- **설정**: `settings.json` env 섹션, 또는 실행 시 env override.

### 2.3 Native Tool Endpoint 설정 (인터넷 + 코드 리서치)

| Tool       | Provider | Override 방법                          | 주요 Env / Config Key                          | 비고 |
|------------|----------|----------------------------------------|------------------------------------------------|------|
| claude     | claude   | ANTHROPIC_BASE_URL                     | + ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY     | OpenRouter/Z.ai 등에서 /api/anthropic 사용 흔함. 일부 OAuth endpoint는 first-party 우회 어려움. |
| claude     | openai-compat | CLAUDE_CODE_USE_OPENAI=1 + OPENAI_BASE_URL | OPENAI_API_KEY, OPENAI_MODEL 등             | openclaude shim이 이 경로를 주로 사용. |
| codex      | codex    | config.toml injection                  | `[model_providers.<id>] base_url=... wire_api="responses" env_key=...` + root `model_provider` | opencodex가 가장 잘 보여줌. `CODEX_HOME` override로 격리 가능. |
| codex      | openai   | openai_base_url (root) 또는 provider   | -                                              | proxy를 OpenAI provider로 위장 가능. |
| grok/xai   | xai      | XAI_API_KEY + baseURL                  | `https://api.x.ai/v1` (OpenAI compat)          | 일부 CLI는 cli-chat-proxy.grok.com 내부 사용 (billing). GROK_BASE_URL / XAI_API_BASE_URL 지원 사례 있음. |
| zai (GLM)  | zai      | ANTHROPIC_BASE_URL (Anthropic wire)    | `https://api.z.ai/api/anthropic` + ANTHROPIC_AUTH_TOKEN | OpenAI compat: `https://api.z.ai/api/coding/paas/v4` 등. Codex에서도 chat/responses wire 지원. |
| general    | -        | -                                      | -                                              | 대부분 OpenAI chat-completions 또는 Anthropic Messages, 최근 Responses API 증가. |

**추가 발견**:
- Codex는 `wire_api = "responses"` 강제 추세 (chat은 deprecate).
- Claude Code는 `ANTHROPIC_BASE_URL` 설정 시 **거의 모든 inference call**을 해당 주소로 보냄 (MCP/tool search 일부 제한될 수 있음).
- Proxy를 가리킬 때는 `requires_openai_auth=true` + Bearer 토큰 or custom header 필요할 수 있음.

### 2.4 ASX 기존 격리 메커니즘
- `src/utils/platform.ts`: `getCodexHome`, `getClaudeConfigDir` (CLAUDE_CONFIG_DIR respect), `getGrokHome` (GROK_HOME respect).
- exec 시 temp dir 생성 → auth.json / .credentials.json 복사 → 해당 HOME env 설정 → spawn → cleanup (exit 시).
- keychain (mac claude)은 직접 `security` 명령으로 write (현재 exec은 아직 완전 backup/restore 미구현, temp file fallback 사용 중).
- spawn은 `stdio: 'inherit'`.

---

## 3. ASX Proxy 컨셉 및 아키텍처

### 3.1 전체 흐름 (예: `asx ed.codex claude "hello"`)

1. `cli.ts` exec action에서 name + targetProvider 파싱 (`<name> <target> [rest...]`).
2. profile = `getAccountByName(name)` → sourceProvider = 'codex'.
3. sourceProvider !== targetProvider → Proxy 모드 진입.
4. **Credential 준비**:
   - Source isolation: ed.codex의 codex cred를 temp CODEX_HOME에 주입 (기존 로직 재사용).
   - Target credential: targetProvider('claude')에 해당하는 계정 선택 (자동 매칭: 동일 prefix `ed.claude` 탐색, 또는 fallback으로 active, 또는 명시적 매핑).
5. **Proxy 시작** (exec 범위 한정):
   - 랜덤 포트로 가벼운 HTTP 서버 (Node http 또는 express-lite) 기동.
   - `/v1/responses` (Codex caller용), `/v1/messages` (Claude caller용) 등 멀티 front 지원.
6. **Source config/env injection** (temp HOME 안에):
   - Codex source: temp `config.toml` 생성 (`model_provider = "asx-proxy"`, `[model_providers.asx-proxy] base_url="http://127.0.0.1:PORT/v1" wire_api="responses" ...`)
   - Claude source: `ANTHROPIC_BASE_URL=http://127.0.0.1:PORT` + `ANTHROPIC_AUTH_TOKEN=...` (proxy가 dummy auth 수용).
7. Native 바이너리 spawn (target에 따라 `claude` 또는 `codex`? → profile의 native bin 사용. target은 backend 결정).
   - 실제: profile의 native bin (ed.codex → codex binary)을 실행. binary가 proxy를 호출.
8. Proxy 내부:
   - Request 수신 → 해당 front parser로 `CanonicalRequest` (또는 OcxParsedRequest 확장)로 변환.
   - Target transformer로 target wire (Anthropic Messages) + target credential + target base_url (또는 직접 xai 등) 빌드.
   - Upstream 호출 (fetch) + stream.
   - Upstream event → source가 기대하는 stream 포맷으로 변환 (parse + re-emit).
9. 종료 시 proxy stop + temp dir cleanup.

**핵심 이점**: native binary는 "자신의 wire"만 알고, proxy가 모든 변환을 담당. 새로운 target (e.g. zai) 추가 시 해당 transformer만 작성.

### 3.2 Internal Common Format 제안

**옵션 A (권장)**: opencodex `OcxParsedRequest` + `AdapterEvent` 를 기반으로 fork/확장.
- Codex Responses가 풍부 (reasoning, custom_tool, previous_response_id, hosted tools).
- Anthropic/OpenAI 변환 경험 이미 있음.
- ASX 버전: `ASXRequest`, `ASXEvent` 로 명명하고 asx 전용 필드 추가 (credential meta, target hint).

**옵션 B**: 중립 "UniversalChat" (messages + tools + reasoning_effort + images + ...).
- 더 간단하지만 edge case (reasoning summary, custom tool)에서 정보 손실 위험.

**구현**: `src/proxy/common.ts` 에 schema + types. Zod 사용 (asx 이미 zod 의존성 있음? 확인 필요 → 없으면 추가 최소화하거나 plain TS interface + runtime guard).

### 3.3 Transformer 구조

```
src/proxy/
  server.ts                 # Proxy HTTP server, multi-protocol front
  common.ts                 # Canonical types + parser helpers
  transformers/
    index.ts
    codex-to-common.ts      # (Responses wire → common)  -- inbound for codex source
    claude-to-common.ts     # (Anthropic /v1/messages → common)
    chat-to-common.ts       # (OpenAI /v1/chat/completions)
    common-to-anthropic.ts  # target=claude
    common-to-openai-chat.ts
    common-to-xai.ts        # (대부분 openai-chat과 동일하거나 약간의 header/model tweak)
    common-to-zai.ts
    common-to-codex-responses.ts
  credential-resolver.ts    # target provider cred + base_url 해석 (asx vault + env fallback)
  event-converters.ts       # stream event 변환 유틸
```

각 transformer는 **순수 함수**에 가깝게 (또는 클래스).

예시 인터페이스 (opencodex 스타일 차용):
```ts
interface WireTransformer {
  // inbound
  parseIncomingRequest(req: IncomingHttp, body: any): Promise<CanonicalRequest>;

  // outbound
  buildUpstreamRequest(common: CanonicalRequest, targetCred: TargetCred): AdapterRequest;

  // stream conversion (source expectation ← upstream events)
  convertStreamEvent(upstreamEvent: any): any;  // or use generator
}
```

Proxy server는 front에 따라 적합한 transformer 쌍을 선택.

### 3.4 Credential & Target Resolution

- `src/proxy/credential-resolver.ts`
  - `resolveTargetCredential(targetProvider, sourceProfileName?)`: 
    - 같은 prefix 프로필 탐색 (`ed.claude` when source=`ed.codex`).
    - 없으면 active account for targetProvider.
    - 없으면 env (`ANTHROPIC_API_KEY` 등).
    - 그래도 없으면 에러.
- Proxy 호출 시 source가 보내는 auth (Codex의 ChatGPT 토큰 등)는 보통 무시하거나 로깅만. 실제 upstream은 target cred 사용.
- Security: temp proxy는 localhost + 랜덤 토큰 or 단순 allow-all (exec 범위 한정).

### 3.5 Proxy Lifecycle (exec 내)

- `exec` action에서 `startAsxProxy({port, targetProvider, sourceProfile})` → 반환 `{url, stop()}`.
- Proxy는 **단일 요청 처리 후에도 유지** (한 세션 동안 여러 turn).
- Native 종료 감지 또는 SIGINT 시 stop + cleanup.
- 포트 충돌 회피: 0번 포트 또는 asx 전용 범위 (예 18700~18799).

대안: in-process fetch 기반 "직접 변환" 모드 (proxy 서버 없이도 동작). 하지만 "Local LLM API Gateway" 컨셉을 위해 실제 HTTP proxy를 우선 구현.

### 3.6 Streaming & 고급 기능 대응

- SSE / NDJSON 모두 지원.
- Tool call (function / custom), parallel, approval.
- Reasoning (budget, summary, thinking content).
- Vision (image_url / base64).
- Cache tokens, usage accounting (나중에 openusage 연동?).
- Abort / timeout 전달.

opencodex의 parseStream + event loop가 좋은 모델.

---

## 4. CLI 통합 계획

### Phase 1: 파싱 + 라우팅 + 기본 direct
- `exec <name> [target?] [rest...]` 파싱 개선.
  - `target` 인자가 provider 이름 목록에 있으면 cross로 간주.
  - Provider registry (현재 providers/index.ts) 확장.
- `isCrossProvider(profile, target)` → true면 proxy path.

### Phase 2: Proxy scaffolding
- `src/proxy/` 디렉토리 + 최소 server (GET /healthz, POST /v1/responses passthrough 예시).
- 기존 exec 로직에 proxy URL 주입 분기.

### Phase 3: Codex → Claude 예시 transformer
- Inbound: Responses 파서 (opencodex responses schema 일부 포팅 또는 fetch body 그대로).
- Outbound: Anthropic Messages 빌더 (openclaude/anthropic adapter 참고).
- Event 변환: Anthropic stream → Codex가 기대하는 Responses stream (텍스트 델타 + tool + usage).

### Phase 4: 전체 provider 매트릭스
- 지원 조합 표 작성 (codex↔claude, claude↔xai, codex↔zai, grok source 등).
- 각 transformer 테스트 (unit + 실제 spawn).

### Phase 5: UX / UX polish
- `asx e ed.codex claude -b "..."` 지원 (bypass는 target binary에 적용).
- 로그: `[asx proxy] codex→claude on :18742`
- 에러 매핑 (target 401 → 유용한 메시지).
- `--proxy-port` override (디버그).

### 명령 예시 (미래)
```
asx e ed.codex claude "리팩토링 해줘"
asx e yano.grok xai "explain ..."
asx e personal.claude zai --model glm-... "hello"
asx e work.codex openai "..."     # proxy로 OpenAI 직접 (이미 codex 지원하지만 일관성)
```

---

## 5. 구현 단계 (구체적 TODO)

1. **준비**
   - `src/proxy/types.ts` (CanonicalRequest, CanonicalEvent 정의. opencodex schema 참고하여 최소 복사/적응).
   - Provider 목록 중앙화 (`src/providers/registry.ts` 신설 또는 확장).

2. **Proxy 서버 기본**
   - `src/proxy/server.ts`: http.createServer, body parse, route by path (`/v1/responses`, `/v1/messages`).
   - 간단 passthrough 모드 먼저 (테스트용).
   - graceful shutdown.

3. **Isolation + Injection helpers 리팩터**
   - `src/exec/isolation.ts` (기존 exec 로직 이동/추출).
   - `src/exec/inject.ts`: `injectCodexConfigForProxy(homeDir, proxyUrl)`, `injectClaudeEnv(...)` 등.
   - Codex inject는 opencodex `buildProviderTableBlock` + strip 로직을 참고 (또는 경량 버전 재구현).

4. **Transformer 구현 (우선순위)**
   - codex-in → common
   - common → anthropic (target claude)
   - anthropic-in → common
   - common → openai-chat (target xai, zai, openai)
   - xai/zai 특수 처리 (model suffix, header, reasoning_effort mapping).

5. **Credential resolver + target base url**
   - target provider별 default base url 상수화.
   - asx vault에서 cred 로드 (providers/*.ts의 getSecret 로직 재사용).

6. **Exec 통합 + end-to-end**
   - bare `asx ed.codex claude` (prompt 없음) 지원.
   - cleanup 시 proxy도 종료.
   - mac claude keychain: temp file + ANTHROPIC_ env가 잘 먹는지 확인 (추가로 CLAUDE_CONFIG_DIR override + keychain write 고려).

7. **테스트 / 검증**
   - unit: transformer roundtrip.
   - integration: 실제 `asx e ...` 로 spawn 후 응답 확인 (mock proxy 또는 실제 키).
   - stream 안정성 (opencodex devlog의 websocket/stream 경험 참고).
   - abort 전파.

8. **문서**
   - README에 cross exec 예시 추가.
   - `docs/proxy-architecture.md` (선택).

---

## 6. 기술적 주의사항 / 리스크

- **Auth 차이**: Codex OAuth (ChatGPT) cred를 proxy가 받더라도 target에는 사용 불가. 항상 target cred 사용.
- **Claude keychain**: macOS에서 `claude` 바이너리는 keychain을 직접 읽음. ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 조합이 잘 동작하는지 (openclaude 경험상 동작하지만 완벽 보장 X). 필요시 temp credentials.json + env 동시 사용.
- **Streaming parity**: Responses vs Messages vs chat/completions 간 delta, tool_call id, finish_reason, usage timing 차이. opencodex adapter가 좋은 선례.
- **Tool approval / sandbox**: bypass (-b)와 proxy가 상호작용할 수 있음.
- **Context / previous_response_id**: stateful Responses를 proxy가 얼마나 보존할지 (codex source → target이 stateless일 경우 id 매핑 필요).
- **성능**: exec마다 proxy spawn은 overhead. (필요시) 상시 proxy daemon 모드 (ocx처럼) 고려 (Phase 6+).
- **의존성**: zod (가능하면), undici/fetch (이미 node 내장). 최소 추가.
- **보안**: localhost proxy라도 exec 동안만 열고, random auth 토큰 옵션 고려.

---

## 7. 확장 로드맵 (Proxy 이후)

- 상시 백그라운드 proxy (`asx proxy start/stop`, port 18700 고정).
- GUI 또는 설정 파일로 provider 매핑 정의.
- Usage 집계 cross (proxy 통과 트래픽을 asx usage에 기록).
- MCP / web_search sidecar passthrough.
- LiteLLM / openrouter 같은 외부 gateway와의 co-existence.

---

## 8. 참고 자료

- opencodex
  - `src/adapters/base.ts`, `anthropic.ts`, `openai-*.ts`
  - `src/responses/schema.ts`
  - `src/codex-inject.ts`, `src/router.ts`
  - `structure/*.md`, devlog
- openclaude
  - `src/services/api/providerConfig.ts`, `openaiShim.ts`, `codexShim.ts`
  - `src/integrations/vendors/xai.ts`, `zai` 관련
  - docs/integrations/*
- Codex 공식: config reference (model_providers, wire_api=responses)
- Claude Code docs: ANTHROPIC_BASE_URL, LLM Gateway
- xAI: `https://api.x.ai/v1` + XAI_API_KEY

---

## 9. 다음 액션 (승인 후)

1. 이 플랜 리뷰 / 조정 (특히 credential resolution 정책, common format 선택).
2. Phase 1 scaffolding PR (types + minimal server + exec 파싱 변경).
3. Codex → Claude transformer 최소 동작 데모.
4. 전체 테스트 + README 업데이트.

**이 플랜은 실제 코드 변경 없이 리서치 + 설계만 반영.** 구현은 별도 단계로 진행.

---

*End of ASX Proxy Plan*
