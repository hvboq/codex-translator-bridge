# Copy this file to config.ps1 and uncomment only the settings you want to change.

# $env:CODEX_BRIDGE_PORT = "8765"
# $env:CODEX_BRIDGE_HOST = "127.0.0.1"
# $env:CODEX_BRIDGE_HOME = "C:\path\to\codex-bridge"
# $env:CODEX_BRIDGE_DATA_DIR = "C:\path\to\codex-bridge-data"
# Use "codex-bridge" to select the current GPT-5.6 default explicitly.
# To pin a model, use an exact gpt-5.6-* ID returned by GET /v1/models.
# $env:CODEX_BRIDGE_MODEL = "codex-bridge"
# Per-request reasoning_effort / reasoning.effort overrides this default.
# none or minimal falls back to the model's lowest advertised effort when needed.
# $env:CODEX_BRIDGE_REASONING_EFFORT = "low" # Must be supported by the selected model.
# $env:CODEX_BRIDGE_TIMEOUT_MS = "90000"
# $env:CODEX_BRIDGE_BODY_LIMIT = "1048576"
# $env:CODEX_BRIDGE_MAX_TEXT_CHARS = "12000"
# $env:CODEX_BRIDGE_MAX_CONCURRENCY = "4"
# $env:CODEX_BRIDGE_BATCH_WINDOW_MS = "80"
# $env:CODEX_BRIDGE_MAX_BATCH_ITEMS = "16"
# $env:CODEX_BRIDGE_CACHE_MAX_ENTRIES = "20000"
# $env:CODEX_BRIDGE_SOURCE = "auto"
# $env:CODEX_BRIDGE_TARGET = "ko"
# $env:CODEX_BRIDGE_PERSIST_CACHE = "true"

# To use a fixed local bearer token, put it only in ignored config.ps1.
# $env:CODEX_BRIDGE_TOKEN = ""
#
# Setting this disables the local bearer token. Keep it false unless a client
# cannot send an Authorization header. The server still refuses non-loopback binds.
# $env:CODEX_BRIDGE_NO_AUTH = "false"

# CODEX_TRANSLATOR_* names from v0.1 remain supported as lower-priority fallbacks.
