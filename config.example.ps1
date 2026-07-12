# Copy this file to config.ps1 and uncomment only the settings you want to change.

# $env:CODEX_TRANSLATOR_PORT = "8765"
# $env:CODEX_TRANSLATOR_HOST = "127.0.0.1"
# $env:CODEX_TRANSLATOR_HOME = "C:\path\to\codex-translator"
# $env:CODEX_TRANSLATOR_DATA_DIR = "C:\path\to\codex-translator-data"
# Leave blank (or use "codex-translator") to select the current GPT-5.6 default.
# To pin a model, use an exact gpt-5.6-* ID returned by GET /v1/models.
# $env:CODEX_TRANSLATOR_MODEL = ""
# $env:CODEX_TRANSLATOR_REASONING_EFFORT = "low" # Must be supported by the selected model.
# $env:CODEX_TRANSLATOR_TIMEOUT_MS = "90000"
# $env:CODEX_TRANSLATOR_BODY_LIMIT = "1048576"
# $env:CODEX_TRANSLATOR_MAX_TEXT_CHARS = "12000"
# $env:CODEX_TRANSLATOR_BATCH_WINDOW_MS = "80"
# $env:CODEX_TRANSLATOR_MAX_BATCH_ITEMS = "16"
# $env:CODEX_TRANSLATOR_CACHE_MAX_ENTRIES = "20000"
# $env:CODEX_TRANSLATOR_SOURCE = "auto"
# $env:CODEX_TRANSLATOR_TARGET = "ko"
# $env:CODEX_TRANSLATOR_PERSIST_CACHE = "true"

# To use a fixed local bearer token, put it only in ignored config.ps1.
# $env:CODEX_TRANSLATOR_TOKEN = ""
#
# Setting this disables the local bearer token. Keep it false unless a client
# cannot send an Authorization header. The server still refuses non-loopback binds.
# $env:CODEX_TRANSLATOR_NO_AUTH = "false"
