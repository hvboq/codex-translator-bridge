# Codex Bridge

Codex Bridge는 사용자의 기존 ChatGPT/Codex 로그인을 로컬 OpenAI 호환 HTTP API로 연결하는 Windows 우선 프로젝트입니다. 일반 채팅과 텍스트 생성이 기본 기능이며, 번역 전용 `/translate` API도 선택적으로 제공합니다.

이 저장소는 독립적인 커뮤니티 프로젝트이며 OpenAI의 공식 제품이나 공식 OpenAI API 서버가 아닙니다.

```text
OpenAI 호환 클라이언트
        ↓  localhost + local bearer token
Codex Bridge
        ↓  Codex App Server
사용자 자신의 ChatGPT/Codex 계정
```

이 프로젝트는 OpenAI API 전체를 복제하지 않습니다. 현재 목표는 GPT-5.6 계열의 안전한 텍스트 전용 호환 계층입니다.

## 지원 범위

| API | 상태 | 설명 |
| --- | --- | --- |
| `GET /v1/models` | 지원 | 현재 계정에 표시되는 GPT-5.6 모델만 반환 |
| `GET /v1/models/{id}` | 지원 | 공개 모델 ID 상세 조회 |
| `POST /v1/chat/completions` | 지원 | system/developer/user/assistant 텍스트 대화 |
| `POST /v1/responses` | 지원 | 문자열 또는 텍스트 message 입력 |
| Chat/Responses `stream: true` | 지원 | Codex의 실제 생성 delta를 SSE로 중계 |
| 출력 토큰 필드 | 호환 지원 | `max_tokens`, `max_completion_tokens`, `max_output_tokens` 검증·수용 |
| `POST /translate` | 선택 지원 | 번역 batching, cache, placeholder 보호 |
| `POST /v1/translate` | 선택 지원 | `/translate` 별칭 |

현재 지원하지 않는 기능:

- 이미지, 오디오, 파일 입력
- function/tool calling 및 내장 도구
- `previous_response_id`, conversation, background response
- 서버 측 response 저장
- 여러 응답을 생성하는 `n > 1`
- stop, seed, penalty 등의 sampling/generation 제어
- 임베딩, 이미지 생성, 오디오, 파인튜닝 등의 다른 OpenAI API

미지원 요청은 조용히 무시하지 않고 `400 invalid_request_error`로 반환합니다.

LunaTranslator를 비롯한 범용 OpenAI 호환 클라이언트는 Chat 요청에 `max_tokens`, `temperature`, `top_p`를 자동으로 넣습니다. Codex Bridge는 이 필드와 `max_completion_tokens`, Responses의 `max_output_tokens`를 형식 검증 후 호환용 advisory 값으로 수용합니다. 현재 Codex App Server에는 이 값을 그대로 전달할 하드 출력 제한 인자가 없으므로 실제 생성 한도를 보장하지는 않으며, 응답의 `X-Codex-Bridge-Advisory-Parameters` 헤더에 advisory로 처리한 null이 아닌 필드를 표시합니다. 브리지 자체의 설정된 출력 문자 안전 제한은 계속 적용됩니다.

가능할 때 Codex App Server가 보고한 최근 turn 사용량을 OpenAI 호환 `usage` 필드로 변환합니다. 이 값에는 Codex 내부 지침과 context가 포함될 수 있어 일반 OpenAI API의 prompt/completion token과 동일한 비용 척도는 아닙니다. App Server가 사용량을 보내지 않으면 `usage`는 `null`입니다.

## 일반 사용자용 Windows 설치

[최신 GitHub Release](https://github.com/hvboq/codex-bridge/releases/latest)에서 `CodexBridge-*-windows-x64.zip`을 받으세요.

1. ZIP을 문서 폴더처럼 쓰기 가능한 위치에 완전히 압축 해제합니다.
2. `Start Codex Bridge.cmd`를 실행합니다.
3. 처음 실행할 때 브라우저에서 ChatGPT/Codex 로그인을 완료합니다.
4. 서버 창을 열어 둡니다.
5. `Copy Local API Key.cmd`를 실행합니다.
6. 원하는 OpenAI 호환 프로그램에 다음 값을 입력합니다.

```text
Base URL: http://127.0.0.1:8765/v1
API Key: 복사한 로컬 키
Model: GET /v1/models에서 보이는 gpt-5.6-* 모델
```

프로그램이 `/v1`을 자동으로 붙이면 Base URL을 `http://127.0.0.1:8765`로 입력하세요. ZIP에는 Node.js와 고정된 공식 Codex 런타임이 포함되므로 Node.js, npm, Git을 따로 설치할 필요가 없습니다.

배포 파일은 아직 코드 서명되지 않아 Windows SmartScreen 경고가 나타날 수 있습니다. Release의 `.sha256` 파일로 ZIP 무결성을 확인할 수 있습니다.

## OpenAI SDK 사용 예시

먼저 `Copy Local API Key.cmd`로 복사한 값을 환경 변수에 넣습니다.

```powershell
$env:CODEX_BRIDGE_API_KEY = "복사한 로컬 키"
```

JavaScript Chat Completions:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CODEX_BRIDGE_API_KEY,
  baseURL: "http://127.0.0.1:8765/v1",
});

const completion = await client.chat.completions.create({
  model: "gpt-5.6-sol",
  messages: [{ role: "user", content: "한국의 수도는 어디야?" }],
});

console.log(completion.choices[0].message.content);
```

JavaScript Responses streaming:

```js
const stream = await client.responses.create({
  model: "gpt-5.6-sol",
  input: "세 문장으로 양자 얽힘을 설명해줘.",
  stream: true,
});

for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    process.stdout.write(event.delta);
  }
}
```

Python:

```python
from openai import OpenAI

client = OpenAI(
    api_key="복사한 로컬 키",
    base_url="http://127.0.0.1:8765/v1",
)

response = client.responses.create(
    model="gpt-5.6-sol",
    input="안녕하세요. 자신을 한 문장으로 소개해줘.",
)
print(response.output_text)
```

## 실제 스트리밍

Chat Completions는 OpenAI 호환 `chat.completion.chunk`와 `[DONE]`을 사용합니다. Responses는 typed SSE 이벤트를 사용합니다.

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta ...
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

Codex App Server의 `item/agentMessage/delta`를 생성 중에 바로 전달합니다. commentary, reasoning, plan 및 도구 이벤트는 외부 응답에 포함하지 않습니다. Responses 스트리밍 형식은 [OpenAI Responses streaming 가이드](https://developers.openai.com/api/docs/guides/streaming-responses)를 따릅니다.

## 번역 기능과 LunaTranslator

LunaTranslator는 지원 클라이언트 중 하나일 뿐이며 프로젝트 전체가 Luna에 종속되지 않습니다. 대형 모델 범용 인터페이스에 같은 Base URL과 키를 입력하면 `/v1/chat/completions`를 사용할 수 있습니다. Luna가 기본 전송하는 `max_tokens`, `temperature`, `top_p`도 호환 처리되므로 별도로 제거할 필요가 없습니다.

번역 정확성과 게임 문자열 보존이 중요하면 전용 API를 권장합니다.

```http
POST /translate
Authorization: Bearer <local-token>
Content-Type: application/json

{
  "model": "gpt-5.6-sol",
  "text": ["こんにちは", "HP: {hp}"],
  "source": "ja",
  "target": "ko",
  "context": ["게임 대사"],
  "glossary": { "勇者": "용사" },
  "style": "자연스러운 게임 대사"
}
```

`/translate`에는 다음 기능이 추가로 적용됩니다.

- 짧은 요청 micro-batching
- 동일 요청 in-flight deduplication
- 모델별 번역 cache
- 태그, 서식 코드, placeholder 보호 및 복원
- structured output 검증과 제한적 재시도

일반 Chat/Responses 요청은 개인정보가 평문 cache에 쌓이지 않도록 영구 cache를 사용하지 않습니다.

## 인증과 401

Codex 로그인과 로컬 HTTP API Key는 서로 다른 자격 증명입니다.

- Codex 로그인: 각 사용자가 브라우저에서 자신의 ChatGPT/Codex 계정으로 로그인
- 로컬 API Key: Codex Bridge가 `data/token.txt`에 생성하는 localhost 전용 bearer token

401이 발생하면:

1. 서버가 실행 중인지 확인합니다.
2. `Copy Local API Key.cmd`를 다시 실행합니다.
3. API Key 칸에는 값만 붙여넣고 `Bearer `를 직접 붙이지 않습니다.
4. 예전 키, 앞뒤 공백, `|` 구분자가 남아 있지 않은지 확인합니다.
5. Base URL이 `http://127.0.0.1:8765/v1`인지 확인합니다.

키는 사용자 PC마다 다릅니다. 배포 ZIP이나 GitHub 저장소에는 어떤 사용자의 토큰도 포함되지 않습니다.

## 소스에서 실행

요구 사항:

- Windows 10/11
- Node.js 18 이상
- Codex를 사용할 수 있는 ChatGPT 계정

```powershell
git clone https://github.com/hvboq/codex-bridge.git
cd codex-bridge
npm.cmd ci
npm.cmd run codex:login
.\start.cmd
```

확인:

```powershell
npm.cmd run codex:status
.\scripts\test-request.ps1
```

## 설정

`config.example.ps1`을 `config.ps1`로 복사한 뒤 필요한 값만 활성화하세요. `config.ps1`은 Git에서 무시됩니다.

주요 환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | loopback만 허용 |
| `CODEX_BRIDGE_PORT` | `8765` | HTTP 포트 |
| `CODEX_BRIDGE_MODEL` | 계정 기본값 | 기본 GPT-5.6 모델 |
| `CODEX_BRIDGE_REASONING_EFFORT` | `low` | 모델이 지원하는 추론 강도 |
| `CODEX_BRIDGE_MAX_CONCURRENCY` | `4` | 일반 생성 동시 실행 수 |
| `CODEX_BRIDGE_TIMEOUT_MS` | `90000` | 요청 제한 시간 |
| `CODEX_BRIDGE_MAX_TEXT_CHARS` | `12000` | 입력 문자 제한 |
| `CODEX_BRIDGE_TOKEN` | 자동 생성 | 고정 로컬 bearer token |
| `CODEX_BRIDGE_NO_AUTH` | `false` | 로컬 token 검사 비활성화 |
| `CODEX_BRIDGE_PERSIST_CACHE` | `true` | `/translate` cache 지속 여부 |

v0.1의 `CODEX_TRANSLATOR_*` 변수는 호환용 fallback으로 계속 지원됩니다. 두 이름이 모두 있으면 `CODEX_BRIDGE_*`가 우선합니다. 기본 모델 별칭도 새 `codex-bridge`와 기존 `codex-translator`를 모두 지원합니다.

## 모델 정책

`GET /v1/models`는 Codex App Server의 실제 모델 목록을 조회한 뒤 보이는 `gpt-5.6-*` 모델만 반환합니다. 모델 제공 여부와 이름은 계정 및 Codex 서비스 상태에 따라 달라질 수 있습니다.

- HTTP 응답에는 공개 model ID를 사용합니다.
- App Server 실행에는 카탈로그가 제공한 실제 runtime model을 사용합니다.
- 존재하지 않거나 GPT-5.6이 아닌 모델은 `400`입니다.
- 계정에 GPT-5.6 모델이 하나도 없으면 실행 요청은 `503`입니다.

## 보안 경계

- HTTP 서버는 `127.0.0.1`, `::1`, `localhost`에만 bind할 수 있습니다.
- bearer 인증이 기본으로 활성화됩니다.
- 각 요청은 ephemeral Codex thread에서 실행됩니다.
- Codex thread는 read-only, network disabled, approval never로 고정됩니다.
- shell, MCP, plugins, apps, browser/computer use, memory, multi-agent 기능은 비활성화됩니다.
- 요청이 임의 `cwd`, tool 또는 로컬 파일 접근 권한을 지정할 수 없습니다.
- Codex 인증 파일은 HTTP API로 노출하지 않습니다.
- 일반 요청과 번역 원문은 모델 처리를 위해 OpenAI의 Codex 서비스로 전송됩니다.

이 서버를 `0.0.0.0`, LAN 또는 인터넷에 공개하는 용도로 사용하지 마세요. 자세한 내용은 [SECURITY.md](SECURITY.md)를 참고하세요.

## 개발과 검증

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run release:windows
```

공식 Codex App Server는 현재 고정된 `@openai/codex` 버전과 함께 사용합니다. 인터페이스가 바뀔 수 있으므로 버전 업그레이드 시 [Codex App Server 문서](https://learn.chatgpt.com/docs/app-server), 모델 목록, 일반 생성, 번역, 스트리밍을 모두 다시 검증해야 합니다.

기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md), 저장소 규칙은 [AGENTS.md](AGENTS.md), 제3자 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.

## 라이선스

프로젝트가 작성한 코드는 [MIT License](LICENSE)입니다. 번들되는 Node.js와 OpenAI Codex 런타임은 각각의 원래 라이선스를 유지하며 Windows ZIP의 `licenses/`에 전문이 포함됩니다.
