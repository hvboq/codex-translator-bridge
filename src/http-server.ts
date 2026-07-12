import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { tokenMatches } from './auth.js';
import { ModelUnavailableError, UnsupportedModelError } from './app-server-client.js';
import { InputError, TranslationService } from './translation-service.js';
import type { ChatMessage, CodexModel, TranslationRequest } from './types.js';

interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

interface StatusProvider {
  getStatus(): Promise<{
    ready: boolean;
    authMode: string | null;
    planType: string | null;
    error?: string;
  }>;
}

export function createHttpServer(
  config: AppConfig,
  localToken: string | null,
  client: StatusProvider,
  translations: TranslationService,
): http.Server {
  const server = http.createServer((request, response) => {
    void route(request, response).catch((error) => sendError(response, error));
  });
  server.requestTimeout = config.requestTimeoutMs + 10_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (method === 'GET' && pathname === '/') {
      sendJson(response, 200, {
        name: 'Codex Translator Bridge',
        endpoints: [
          '/health',
          '/translate',
          '/v1/chat/completions',
          '/v1/models',
          '/v1/models/{id}',
        ],
      });
      return;
    }
    if (method === 'GET' && pathname === '/health') {
      const status = await client.getStatus();
      sendJson(response, status.ready ? 200 : 503, {
        status: status.ready ? 'ok' : 'unavailable',
        engine: 'codex-app-server',
        auth_mode: status.authMode,
        plan_type: status.planType,
        error: status.error,
      });
      return;
    }

    if (!tokenMatches(localToken, request.headers.authorization)) {
      sendJson(response, 401, {
        error: { message: 'Missing or invalid local bearer token', type: 'authentication_error' },
      });
      return;
    }

    if (method === 'GET' && pathname === '/v1/models') {
      const models = await translations.listModels();
      sendJson(response, 200, {
        object: 'list',
        data: models.map(toModelResponse),
      });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/v1/models/')) {
      const requestedId = decodeModelId(pathname.slice('/v1/models/'.length));
      const models = await translations.listModels();
      const normalized = requestedId.toLowerCase();
      const model = models.find((entry) => entry.id.toLowerCase() === normalized);
      if (!model) {
        throw new UnsupportedModelError(requestedId, models.map((entry) => entry.id));
      }
      sendJson(response, 200, toModelResponse(model));
      return;
    }

    if (
      method === 'POST' &&
      (pathname === '/translate' || pathname === '/v1/translate')
    ) {
      const body = await readJson<TranslationRequest>(request, config.bodyLimitBytes);
      const result = await translations.translate(body);
      const isSingle = typeof body.text === 'string';
      sendJson(response, 200, {
        translation: isSingle ? result.translations[0] : undefined,
        translations: result.translations,
        cached: isSingle ? result.cached[0] : result.cached,
        duration_ms: result.durationMs,
        engine: 'codex',
        model: result.model,
      });
      return;
    }

    if (method === 'POST' && pathname === '/v1/chat/completions') {
      const body = await readJson<ChatCompletionRequest>(request, config.bodyLimitBytes);
      if (!Array.isArray(body.messages)) {
        throw new InputError('messages must be an array');
      }
      const result = await translations.translateChat(body.messages, body.model);
      sendChatCompletion(response, result.content, result.model, body.stream === true);
      return;
    }

    sendJson(response, 404, {
      error: { message: 'Route not found', type: 'not_found_error' },
    });
  }
}

async function readJson<T>(request: IncomingMessage, limit: number): Promise<T> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new InputError('Request body is too large');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new InputError('Request body is too large');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new InputError('Request body must be valid JSON');
  }
}

function sendChatCompletion(
  response: ServerResponse,
  content: string,
  model: string,
  stream: boolean,
): void {
  const id = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  if (stream) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
        }) +
        '\n\n',
    );
    response.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) +
        '\n\n',
    );
    response.end('data: [DONE]\n\n');
    return;
  }

  sendJson(response, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function decodeModelId(value: string): string {
  if (!value || value.includes('/')) {
    throw new InputError('Model ID is invalid');
  }
  try {
    const decoded = decodeURIComponent(value).trim();
    if (!decoded || decoded.includes('/')) {
      throw new InputError('Model ID is invalid');
    }
    return decoded;
  } catch (error) {
    if (error instanceof InputError) {
      throw error;
    }
    throw new InputError('Model ID is invalid');
  }
}

function toModelResponse(model: CodexModel): Record<string, unknown> {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: 'openai',
    display_name: model.displayName,
    is_default: model.isDefault,
    default_reasoning_effort: model.defaultReasoningEffort,
    supported_reasoning_efforts: model.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    ),
    input_modalities: model.inputModalities,
  };
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const status =
    error instanceof InputError || error instanceof UnsupportedModelError
      ? 400
      : error instanceof ModelUnavailableError
        ? 503
        : /timed out/i.test(message)
          ? 504
          : /not authenticated|login|unauthorized/i.test(message)
            ? 503
            : /queue is full/i.test(message)
              ? 429
              : 500;
  sendJson(response, status, {
    error: {
      message,
      type: status === 400 ? 'invalid_request_error' : 'codex_bridge_error',
    },
  });
}
