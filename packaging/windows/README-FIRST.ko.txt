Codex Translator Bridge - Windows x64 간편 실행판
===================================================

필수 조건
---------
- Windows 10 또는 Windows 11 64비트
- Codex를 사용할 수 있는 ChatGPT 계정
- 인터넷 연결

Node.js, npm, Git은 별도로 설치하지 않아도 됩니다.

처음 사용하는 방법
------------------
1. ZIP 파일을 원하는 폴더에 완전히 압축 해제합니다.
   Program Files가 아닌 문서 폴더 같은 쓰기 가능한 위치를 권장합니다.

2. "Start Codex Translator.cmd"를 더블클릭합니다.
   처음 한 번은 브라우저에서 ChatGPT/Codex 로그인이 진행됩니다.
   서버가 실행된 검은 창은 번역하는 동안 닫지 마세요.

3. "Copy Luna API Key.cmd"를 더블클릭합니다.
   이 PC에서만 사용하는 로컬 API Key가 클립보드에 복사됩니다.

4. LunaTranslator의 "대형 모델 범용 인터페이스"에 다음을 입력합니다.
   API 주소: http://127.0.0.1:8765
   API Key: 클립보드에 복사된 값만 붙여넣기 (Bearer 접두사 금지)

5. model 새로고침 버튼을 누르고 gpt-5.6-* 모델을 선택합니다.
   처음에는 스트리밍과 동시 번역을 끄고 테스트하는 것을 권장합니다.

종료와 다시 실행
----------------
- 서버 창에서 Ctrl+C를 누르거나 창을 닫으면 종료됩니다.
- 다음부터는 "Start Codex Translator.cmd"만 실행하면 됩니다.

문제 해결
---------
- 401 오류: API Key 칸을 완전히 비운 뒤 "Copy Luna API Key.cmd"로 다시 복사하세요.
  API Key 칸에 | 문자, Bearer 접두사, 예전 키가 없어야 합니다.
- 로그인 변경: "Codex Login.cmd"를 실행하세요.
- 포트 변경: config.example.ps1을 config.ps1로 복사한 뒤 포트를 수정하세요.
- 캐시 초기화: 서버를 끈 뒤 data\translations.jsonl을 삭제하세요.
- 로컬 API Key 재발급: 서버를 끈 뒤 data\token.txt를 삭제하고 다시 시작하세요.

보안과 개인정보
--------------
- data\token.txt, config.ps1, data\translations.jsonl은 공유하지 마세요.
- 번역 원문은 Codex 처리를 위해 OpenAI 서비스로 전송됩니다.
- 이 프로그램은 127.0.0.1에서만 동작하며 인터넷/LAN 공개용 서버가 아닙니다.
- Codex 로그인 정보는 배포 ZIP에 포함되지 않고 각 사용자 PC에 별도로 저장됩니다.

프로젝트: https://github.com/hvboq/codex-translator-bridge
라이선스: MIT
