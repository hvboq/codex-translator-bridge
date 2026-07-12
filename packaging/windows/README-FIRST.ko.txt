Codex Bridge - Windows x64 간편 실행판
======================================

Codex Bridge는 사용자의 ChatGPT/Codex 로그인을 OpenAI 호환 로컬 HTTP API로 연결합니다.
일반 채팅·텍스트 생성이 기본 기능이며 번역 엔드포인트도 선택적으로 제공합니다.
이 프로그램은 독립적인 커뮤니티 프로젝트이며 OpenAI의 공식 제품이 아닙니다.

필수 조건
---------
- Windows 10 또는 Windows 11 64비트
- Codex를 사용할 수 있는 ChatGPT 계정
- 인터넷 연결

Node.js, npm, Git은 별도로 설치하지 않아도 됩니다.

처음 사용하는 방법
------------------
1. ZIP 파일을 문서 폴더처럼 쓰기 가능한 위치에 완전히 압축 해제합니다.
2. "Start Codex Bridge.cmd"를 더블클릭합니다.
3. 처음 한 번은 브라우저에서 ChatGPT/Codex 로그인을 완료합니다.
4. 서버가 실행된 검은 창을 사용하는 동안 계속 열어 둡니다.
5. "Copy Local API Key.cmd"를 실행해 이 PC 전용 로컬 키를 복사합니다.

OpenAI 호환 프로그램 설정
-------------------------
Base URL: http://127.0.0.1:8765/v1
API Key: 복사한 값만 입력 (Bearer 접두사는 붙이지 않음)
Model: 모델 목록을 새로고침한 뒤 gpt-5.6-* 중 하나 선택

프로그램이 /v1을 자동으로 붙인다면 Base URL을 http://127.0.0.1:8765 로 입력하세요.

지원 API
--------
- GET  /v1/models
- POST /v1/chat/completions
- POST /v1/responses
- POST /translate 및 /v1/translate (선택적 번역 도우미)
- Chat Completions 및 Responses의 실시간 SSE 스트리밍

현재는 텍스트 전용 호환 계층입니다. 이미지·오디오·파일·도구 호출·서버 저장 대화는
지원하지 않으며, 이런 요청은 조용히 무시하지 않고 400 오류로 알려줍니다.

LunaTranslator
--------------
LunaTranslator의 대형 모델 범용 인터페이스에도 같은 주소와 키를 사용할 수 있습니다.
번역 캐시와 placeholder 보호가 꼭 필요하면 /translate 경로 또는 전용 연동을 권장합니다.

종료와 다시 실행
----------------
- 서버 창에서 Ctrl+C를 누르거나 창을 닫으면 종료됩니다.
- 다음부터는 "Start Codex Bridge.cmd"만 실행하면 됩니다.

문제 해결
---------
- 401 오류: API Key를 비우고 "Copy Local API Key.cmd"로 다시 복사하세요.
  키 앞에 Bearer를 직접 붙이지 말고 예전 키나 | 문자가 남아 있지 않은지 확인하세요.
- 로그인 변경: "Codex Login.cmd"를 실행하세요.
- 포트 변경: config.example.ps1을 config.ps1로 복사한 뒤 포트를 수정하세요.
- 번역 캐시 초기화: 서버를 끈 뒤 data\translations.jsonl을 삭제하세요.
- 로컬 API Key 재발급: 서버를 끈 뒤 data\token.txt을 삭제하고 다시 시작하세요.

v0.1에서 이전할 때
------------------
기존 서버를 먼저 종료하세요. 필요하면 예전 폴더의 config.ps1, data\token.txt,
data\translations.jsonl만 새 폴더로 복사할 수 있습니다. app, runtime, data\runtime은
복사하지 마세요. 기존 CODEX_TRANSLATOR_* 설정도 호환용으로 계속 인식됩니다.

보안과 개인정보
--------------
- data\token.txt, config.ps1, data\translations.jsonl은 공유하지 마세요.
- 요청 내용은 Codex 처리를 위해 OpenAI 서비스로 전송됩니다.
- 서버는 loopback 주소에서만 동작하며 인터넷이나 LAN 공개용이 아닙니다.
- Codex 로그인 정보는 ZIP에 포함되지 않고 사용자 PC에 별도로 저장됩니다.
- 일반 Chat/Responses 요청은 로컬 번역 캐시에 저장하지 않습니다.

프로젝트: https://github.com/hvboq/codex-bridge
라이선스: MIT
