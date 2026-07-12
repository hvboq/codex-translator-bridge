# Codex Translator Bridge

> 비공식 커뮤니티 프로젝트입니다. OpenAI, Codex, ChatGPT 또는 LunaTranslator의 공식 제품이 아니며 해당 프로젝트들과 제휴하거나 보증받지 않았습니다.

ChatGPT에 로그인된 Codex를 로컬 번역 엔진처럼 사용하는 Windows용 브리지입니다.

현재 0.1.0 MVP는 실제 Codex 로그인, 번역, 캐시, LunaTranslator 호환 응답까지 검증된 상태입니다.

- Codex API 키가 아니라 로컬 Codex의 ChatGPT 로그인 재사용
- 127.0.0.1 전용 HTTP 서버
- LunaTranslator가 바로 연결할 수 있는 OpenAI Chat Completions 호환 서브셋
- 전용 단일/배치 번역 API
- 80ms 마이크로 배치, 동시 중복 제거, 영구 번역 캐시
- HTML 태그, {name}, %03d, \n, [wait] 같은 게임 토큰 보호와 검증
- 읽기 전용 샌드박스 및 shell, MCP, plugin, browser 도구 비활성화
- 요청마다 저장되지 않는 ephemeral Codex thread 사용

중요: 이것은 “API 키 없이” 사용하는 방식이지 오프라인 GPT가 아닙니다. Codex가 인터넷을 통해 OpenAI 서비스에 접속하며, 사용자의 ChatGPT/Codex 구독 한도와 속도 제한을 사용합니다.

## 구조

    LunaTranslator 또는 다른 번역기
                  |
        http://127.0.0.1:8765
                  |
        Codex Translator Bridge
          - 인증 토큰
          - 배치/중복 제거
          - 번역 캐시
          - 태그 보호
                  |
      공식 Codex App Server (stdio JSON-RPC)
                  |
          사용자의 Codex 로그인

Hermes가 비공개 ChatGPT 백엔드와 OAuth를 직접 복제하는 방식은 사용하지 않습니다. OpenAI가 제품 내 임베딩 용도로 문서화한 [Codex App Server](https://developers.openai.com/codex/app-server)와 공식 npm Codex 런타임만 사용합니다.

Codex App Server는 아직 변경 가능성이 있는 실험적 인터페이스입니다. 이 저장소는 검증한 @openai/codex 0.144.1을 정확히 고정하며, 버전을 올릴 때는 스키마와 실제 번역을 다시 검증해야 합니다.

## 일반 사용자용 설치

개발 도구가 익숙하지 않다면 [최신 GitHub Release](https://github.com/hvboq/codex-translator-bridge/releases/latest)에서 `CodexTranslatorBridge-*-windows-x64.zip`을 받으십시오.

1. ZIP을 문서 폴더처럼 쓰기 가능한 위치에 완전히 압축 해제합니다.
2. `Start Codex Translator.cmd`를 더블클릭합니다.
3. 처음 실행할 때 브라우저에서 ChatGPT/Codex 로그인을 완료합니다.
4. 서버 창을 열어 둔 상태에서 `Copy Luna API Key.cmd`를 실행합니다.
5. LunaTranslator의 대형 모델 범용 인터페이스에 주소 `http://127.0.0.1:8765`와 복사된 키를 입력합니다.
6. 모델 목록을 새로고침하고 `gpt-5.6-*` 모델을 선택합니다.

포터블 ZIP에는 Node.js와 공식 Codex 런타임이 포함되므로 Node.js, npm, Git을 별도로 설치할 필요가 없습니다. Windows 10/11 x64와 Codex를 사용할 수 있는 ChatGPT 계정이 필요합니다. 로그인 정보와 로컬 API Key는 배포 파일에 들어 있지 않으며 각 사용자 PC에서 따로 생성됩니다.

배포 파일은 아직 코드 서명되지 않았으므로 Windows SmartScreen이 경고할 수 있습니다. Release에 함께 제공되는 `.sha256` 파일로 ZIP 무결성을 확인할 수 있습니다. 자세한 단계와 문제 해결은 ZIP 안의 `README-FIRST.ko.txt`를 참고하십시오.

## 소스에서 실행할 때 요구 사항

- Windows 10/11
- Node.js 18 이상
- Codex를 사용할 수 있는 ChatGPT 계정

전역 Codex CLI 설치는 필수가 아닙니다. package-lock.json에 고정된 공식 Codex 런타임을 설치하며, 기존 Codex 로그인 저장소는 그대로 재사용합니다. 현재 개발 PC에서는 Node.js 24와 ChatGPT 로그인으로 검증했습니다.

## 소스에서 빠른 시작

PowerShell에서:

~~~powershell
npm.cmd ci
npm.cmd run codex:status
~~~

로그인되어 있지 않다면:

~~~powershell
npm.cmd run codex:login
~~~

그다음 start.cmd를 더블클릭하거나 다음을 실행합니다.

~~~powershell
.\start.cmd
~~~

정상 시작 후 다음 엔드포인트를 사용할 수 있습니다.

| 메서드와 경로 | 인증 | 용도 |
|---|---|---|
| GET /health | 불필요 | Codex 로그인 및 브리지 상태 |
| GET /v1/models | bearer token | 사용 가능한 GPT-5.6 모델 목록 |
| GET /v1/models/:id | bearer token | 특정 GPT-5.6 모델 조회 |
| POST /translate | bearer token | 전용 단일·배치 번역 |
| POST /v1/translate | bearer token | 전용 API 별칭 |
| POST /v1/chat/completions | bearer token | Chat Completions 호환 서브셋 |

첫 실행 때 data/token.txt에 로컬 bearer token이 생성됩니다. 클립보드로 복사하려면:

~~~powershell
(Get-Content .\data\token.txt -Raw).Trim() | Set-Clipboard
~~~

이 토큰은 OpenAI API 키가 아닙니다. 같은 PC에서 브리지 호출을 제한하기 위한 임의의 로컬 비밀값입니다.

## 모델 조회와 선택

GET /v1/models는 Codex App Server의 현재 모델 카탈로그를 조회한 뒤, 로그인한 계정에 실제로 노출된 `gpt-5.6-*` 모델만 OpenAI 호환 형식으로 반환합니다. 설치 시점의 고정 목록이 아니므로 계정과 Codex 런타임에 따라 결과가 달라질 수 있습니다. 자세한 원본 필드는 [Codex App Server의 `model/list` 문서](https://learn.chatgpt.com/docs/app-server#models)를 참고하십시오.

GET /v1/models/:id는 목록에 있는 정확한 모델 ID 하나를 조회합니다. 목록에 없거나 GPT-5.6 계열이 아닌 ID는 사용할 수 없습니다. 두 모델 조회 엔드포인트 모두 다른 번역 엔드포인트처럼 로컬 bearer token을 요구합니다.

`codex-translator`는 기존 설정을 위한 기본 별칭입니다. 이 별칭은 /v1/models 목록에는 나타나지 않으며, 요청 시 CODEX_TRANSLATOR_MODEL 또는 현재 GPT-5.6 기본 모델로 해석됩니다. 특정 모델을 고르려면 먼저 /v1/models에서 반환된 정확한 ID를 사용하십시오. POST /translate의 선택적 `model`과 POST /v1/chat/completions의 `model`은 표시값이 아니라 실제 ephemeral Codex thread의 모델을 선택하며, 응답의 `model`에는 해석된 실제 모델 ID가 반환됩니다. 실행 모델은 App Server의 [`thread/start.model`](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)에 전달됩니다.

## LunaTranslator 연결

LunaTranslator 파일을 수정하지 않는 방법이 우선입니다.

1. 번역 설정에서 “대형 모델 범용 인터페이스” 계열 번역기를 추가합니다.
2. API 주소에 http://127.0.0.1:8765 를 입력합니다.
3. 모델 목록을 새로 고친 뒤 브리지가 반환한 `gpt-5.6-*` 모델 하나를 선택합니다. 목록 조회를 지원하지 않는 버전에서는 정확한 모델 ID를 직접 입력합니다.
4. API key에는 data/token.txt의 값을 입력합니다.
5. 첫 검증은 스트리밍을 끄고 진행합니다. 검증 후 켜도 됩니다.
6. 안정성 확인 전에는 동시 번역 수 1을 권장합니다. 이후 2~4로 높이면 가까운 요청들이 마이크로 배치로 묶일 수 있습니다.

2026-07-11 기준 LunaTranslator upstream은 base URL에 /v1/chat/completions를 붙여 호출합니다. 404가 발생하는 버전에서는 전체 주소 http://127.0.0.1:8765/v1/chat/completions 를 직접 입력하십시오.

LunaTranslator가 보낸 `model`은 실제 Codex thread 모델을 선택합니다. 기존 설정의 `codex-translator`도 계속 사용할 수 있지만 현재 GPT-5.6 기본 모델을 자동 선택하는 별칭이므로 모델 목록에는 표시되지 않습니다. 원하는 모델을 고정하려면 /v1/models에서 확인한 정확한 ID를 선택하십시오. `temperature`나 `max_tokens` 같은 일반 OpenAI 매개변수는 현재 사용하지 않습니다.

이 브리지는 비스트리밍과 SSE 형식 호환 응답을 모두 지원합니다. SSE는 완성된 번역을 한 번에 보내는 호환 모드이며 토큰 단위 실시간 생성은 아닙니다. 참고: [LunaTranslator 범용 LLM 문서](https://docs.lunatranslator.org/ko/guochandamoxing.html).

## 전용 번역 API

요청:

~~~json
{
  "text": ["こんにちは。", "この名前を覚えておいて。"],
  "source": "ja",
  "target": "ko",
  "model": "gpt-5.6-sol",
  "context": ["게임 대화"],
  "glossary": {
    "名前": "이름"
  },
  "style": "natural game dialogue"
}
~~~

응답:

~~~json
{
  "translations": ["안녕하세요.", "이 이름을 기억해 둬."],
  "cached": [false, false],
  "duration_ms": 8099,
  "engine": "codex",
  "model": "gpt-5.6-sol"
}
~~~

`model`은 선택 사항입니다. 생략하거나 `codex-translator`를 보내면 현재 GPT-5.6 기본 모델을 사용하고, 정확한 모델을 지정할 때는 먼저 /v1/models에 표시되는지 확인하십시오. 응답의 `model`은 실제 사용한 ID입니다. 단일 문자열을 보내면 translation 필드도 함께 반환합니다.

PowerShell 스모크 테스트:

~~~powershell
.\scripts\test-request.ps1
~~~

## 설정

config.example.ps1을 config.ps1로 복사한 뒤 필요한 값만 활성화합니다.

| 환경 변수 | 기본값 | 설명 |
|---|---:|---|
| CODEX_TRANSLATOR_HOST | 127.0.0.1 | loopback 주소만 허용 |
| CODEX_TRANSLATOR_PORT | 8765 | 로컬 HTTP 포트 |
| CODEX_TRANSLATOR_HOME | 현재 작업 디렉터리 | data 기본 경로의 기준 |
| CODEX_TRANSLATOR_DATA_DIR | 프로젝트의 data | 토큰·캐시·런타임 디렉터리 |
| CODEX_TRANSLATOR_MODEL | GPT-5.6 기본 모델 자동 선택 | 비어 있거나 `codex-translator`면 자동 선택, /v1/models의 정확한 ID면 기본 모델 고정 |
| CODEX_TRANSLATOR_REASONING_EFFORT | low | minimal, low, medium, high, xhigh, max, ultra 중 선택 모델이 지원하는 값 |
| CODEX_TRANSLATOR_TIMEOUT_MS | 90000 | 요청 제한 시간 |
| CODEX_TRANSLATOR_BODY_LIMIT | 1048576 | HTTP 요청 본문 최대 바이트 |
| CODEX_TRANSLATOR_MAX_TEXT_CHARS | 12000 | 한 요청의 전체 원문 글자 제한 |
| CODEX_TRANSLATOR_BATCH_WINDOW_MS | 80 | 동시 문장을 묶어 기다리는 시간 |
| CODEX_TRANSLATOR_MAX_BATCH_ITEMS | 16 | 한 Codex 호출의 최대 문장 수 |
| CODEX_TRANSLATOR_CACHE_MAX_ENTRIES | 20000 | 메모리·영구 캐시 최대 항목 |
| CODEX_TRANSLATOR_SOURCE | auto | 전용 API 기본 원본 언어 |
| CODEX_TRANSLATOR_TARGET | ko | 전용 API 기본 도착 언어 |
| CODEX_TRANSLATOR_PERSIST_CACHE | true | data/translations.jsonl 영구 캐시 |
| CODEX_TRANSLATOR_TOKEN | 자동 생성 | 직접 지정할 로컬 bearer token |
| CODEX_TRANSLATOR_NO_AUTH | false | 로컬 bearer token 검사 비활성화 |

서버 주소는 의도적으로 127.0.0.1, ::1, localhost만 허용합니다.

## 보안과 데이터

- 게임·자막 원문도 프롬프트 인젝션을 포함할 수 있는 비신뢰 입력으로 취급합니다.
- 번역 thread에는 shell, MCP, plugin, app, browser, computer-use, web search를 비활성화합니다.
- 전용 빈 작업 디렉터리와 읽기 전용 sandbox를 사용합니다.
- Codex 인증 파일을 읽거나 복사하거나 HTTP로 노출하지 않습니다.
- 원문과 결과는 기본적으로 data/translations.jsonl에 평문 캐시됩니다. 저장이 싫다면 CODEX_TRANSLATOR_PERSIST_CACHE=false로 설정하십시오.
- 번역 원문은 Codex 처리를 위해 OpenAI 서비스로 전송됩니다.

브리지를 LAN이나 인터넷에 공개하거나, 한 ChatGPT 계정을 여러 사용자에게 프록시하거나, 사용 한도를 우회하는 용도로 사용하지 마십시오. 각 사용자가 자신의 PC에서 자신의 Codex 계정으로 로그인하는 개인용 로컬 구조를 전제로 합니다. 공개·다중 사용자 서비스에는 OpenAI API 또는 적절한 Enterprise 인증을 사용해야 합니다. 인증 방식은 [OpenAI Codex 인증 문서](https://developers.openai.com/codex/auth)를 참고하십시오.

## 성능 특성

Codex는 ezTrans 같은 전용 로컬 번역기가 아니라 범용 에이전트이므로 캐시되지 않은 문장은 즉시 나오지 않습니다. 이 PC에서 확인한 예시는 다음과 같습니다.

- 캐시되지 않은 짧은 번역: 약 8~16초
- 동일 요청 캐시 적중: 0~수 ms

네트워크, 모델, 구독 상태에 따라 크게 달라집니다. 짧은 문장을 무조건 한 줄씩 보내기보다 LunaTranslator의 동시 요청이 80ms 창에서 묶이도록 두고, 반복 대사가 캐시를 사용하게 하는 것이 중요합니다.

잘못된 번역도 캐시에 남을 수 있습니다. 브리지를 종료한 뒤 data/translations.jsonl을 삭제하면 캐시가 초기화됩니다. 캐시 키에는 App Server의 실제 실행 모델이 포함되므로 서로 다른 GPT-5.6 모델의 결과가 섞이지 않습니다. 기존 캐시 자체를 완전히 없애려면 파일을 삭제하십시오.

## ezTrans DLL 호환에 대하여

LunaTranslator 연동만을 위해 J2KEngine.dll을 흉내 낼 필요는 없습니다. LunaTranslator의 ezTrans 경로는 32비트 DLL, 여러 J2K export, CP932/CP949 인코딩, 반환 메모리 소유권까지 맞춰야 하므로 HTTP보다 훨씬 취약합니다.

향후 HTTP 설정을 지원하지 않고 ezTrans ABI만 받는 별도 프로그램이 꼭 필요할 때, 이 브리지 앞에 독립적인 x86 shim을 추가하는 편이 좋습니다.

## 문제 해결

### 401 Missing or invalid local bearer token

이 오류는 Codex 로그인이 아니라 브리지의 로컬 인증 오류입니다. LunaTranslator의 API 주소를 `http://127.0.0.1:8765`로 두고, API key 칸에는 `Bearer ` 접두사 없이 data/token.txt의 64자 값을 넣습니다. 정확한 값을 클립보드에 다시 복사하려면 다음 명령을 사용하십시오.

~~~powershell
(Get-Content .\data\token.txt -Raw).Trim() | Set-Clipboard
~~~

config.ps1에서 CODEX_TRANSLATOR_TOKEN을 직접 지정했다면 파일 대신 그 값을 사용해야 합니다. 설정을 저장한 뒤 모델 목록을 새로 고치거나 LunaTranslator를 재시작하십시오.

### 503 또는 로그인 오류

~~~powershell
npm.cmd run codex:status
npm.cmd run codex:login
~~~

로그인 후 브리지를 다시 시작합니다.

### 모델이 목록에 없거나 400 오류가 발생함

GET /v1/models를 다시 조회해 현재 계정에 노출된 정확한 `gpt-5.6-*` ID를 사용하십시오. GPT-5.6 이외의 모델, 오래된 ID, 임의 문자열은 거부됩니다. 자동 선택으로 되돌리려면 요청 모델을 `codex-translator`로 바꾸거나 CODEX_TRANSLATOR_MODEL을 비웁니다.

### EADDRINUSE

8765 포트를 이미 사용하는 브리지나 다른 프로그램이 있습니다. 기존 브리지를 사용하거나 config.ps1에서 CODEX_TRANSLATOR_PORT를 변경합니다.

### 번역 제한 시간 초과

Codex 사용량 한도와 네트워크 상태를 확인합니다. 필요하면 CODEX_TRANSLATOR_TIMEOUT_MS를 늘리되, LunaTranslator 쪽 제한 시간도 함께 조정합니다.

## 개발과 기여

~~~powershell
npm.cmd run check
npm.cmd run release:windows
~~~

기여 전에 [CONTRIBUTING.md](CONTRIBUTING.md)를 확인하십시오. 저장소 구조, 보안 불변조건, 테스트 규칙은 [AGENTS.md](AGENTS.md), 로컬 토큰과 캐시 취급 방법은 [SECURITY.md](SECURITY.md)를 참고하십시오. 이슈나 로그를 올릴 때는 bearer token, Codex 인증 정보, 번역 원문, 캐시 내용과 사용자명이 포함된 로컬 경로를 반드시 제거하십시오.

이 저장소에서 자체 작성해 배포하는 코드와 문서는 모두 [MIT License](LICENSE)입니다. 누구나 사용, 복사, 수정, 병합, 게시, 배포, 재라이선스 및 판매할 수 있으며, 저작권·허가 고지를 유지해야 하고 소프트웨어는 무보증으로 제공됩니다. 설치 시 내려받는 제3자 패키지는 각 패키지의 라이선스를 따르며 이 저장소가 이를 재라이선스하지 않습니다. 직접 의존성의 라이선스 정보는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하십시오.

OpenAI의 [비대화형 실행 문서](https://developers.openai.com/codex/noninteractive)와 [Codex SDK 문서](https://developers.openai.com/codex/sdk)도 Codex를 스크립트 및 자체 애플리케이션에서 제어하는 방식을 제공합니다. 이 프로젝트는 장기 프로세스와 ephemeral thread를 함께 쓰기 위해 App Server를 선택하고, 호환 런타임 버전을 package-lock.json에 고정합니다.
