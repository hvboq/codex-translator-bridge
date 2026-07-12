import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { tokenMatches } from './auth.js';
import { ModelUnavailableError, UnsupportedModelError } from './app-server-client.js';
import {
  GenerationService,
  normalizeReasoningEffort,
  type PreparedGeneration,
} from './generation-service.js';
import { InputError, TranslationService } from './translation-service.js';
import type {
  CodexModel,
  RequestedReasoning,
  TokenUsage,
  TranslationRequest,
} from './types.js';

interface StatusProvider {
  getStatus(): Promise<{
    ready: boolean;
    authMode: string | null;
    planType: string | null;
    error?: string;
  }>;
}

type JsonObject = Record<string, unknown>;

export function createHttpServer(
  config: AppConfig,
  localToken: string | null,
  client: StatusProvider,
  translations: TranslationService,
  generations: GenerationService,
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
        name: 'Codex Bridge',
        compatibility: 'OpenAI-compatible text subset',
        endpoints: [
          '/health',
          '/v1/models',
          '/v1/models/{id}',
          '/v1/chat/completions',
          '/v1/responses',
          '/translate (optional translation helper)',
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

    if (method === 'POST' && (pathname === '/translate' || pathname === '/v1/translate')) {
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
      const body = await readObject(request, config.bodyLimitBytes);
      const advisoryParameters = validateChatRequest(body);
      const reasoning = parseChatReasoning(body);
      const prepared = await generations.prepareChat(body.messages, body.model, reasoning);
      setAdvisoryParametersHeader(response, advisoryParameters);
      setReasoningHeaders(response, prepared);
      if (body.stream === true) {
        await streamChatCompletion(request, response, generations, prepared, body);
      } else {
        const abortController = requestAbortController(request, response);
        const result = await generations.generate(prepared, { signal: abortController.signal });
        sendChatCompletion(response, result.content, result.model, result.usage);
      }
      return;
    }

    if (method === 'POST' && pathname === '/v1/responses') {
      const body = await readObject(request, config.bodyLimitBytes);
      const advisoryParameters = validateResponsesRequest(body);
      const reasoning = parseResponsesReasoning(body);
      const prepared = await generations.prepareResponse(
        body.input,
        body.instructions,
        body.model,
        reasoning,
      );
      setAdvisoryParametersHeader(response, advisoryParameters);
      setReasoningHeaders(response, prepared);
      if (body.stream === true) {
        await streamResponse(request, response, generations, prepared, body);
      } else {
        const abortController = requestAbortController(request, response);
        const result = await generations.generate(prepared, { signal: abortController.signal });
        const ids = responseIds();
        sendJson(
          response,
          200,
          createResponseObject(
            ids,
            result.model,
            result.content,
            body,
            prepared.reasoningEffort,
            'completed',
            result.usage,
          ),
        );
      }
      return;
    }

    sendJson(response, 404, {
      error: { message: 'Route not found', type: 'not_found_error' },
    });
  }
}

async function readObject(request: IncomingMessage, limit: number): Promise<JsonObject> {
  const value = await readJson<unknown>(request, limit);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('Request body must be an object');
  }
  return value as JsonObject;
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

function validateChatRequest(body: JsonObject): string[] {
  validateStream(body.stream);
  const advisoryParameters = validateAdvisoryParameters(body, [
    ['max_tokens', 'positiveInteger'],
    ['max_completion_tokens', 'positiveInteger'],
    ['temperature', 'temperature'],
    ['top_p', 'probability'],
  ]);
  if (body.n !== undefined && body.n !== 1) {
    throw new InputError('Only n=1 is supported');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) {
    throw new InputError('Tool calling is not supported');
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'none') {
    throw new InputError('Only tool_choice="none" is supported');
  }
  rejectPresent(body, [
    'functions',
    'function_call',
    'audio',
    'stop',
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'verbosity',
    'service_tier',
    'prediction',
    'web_search_options',
  ]);
  if (body.stream_options !== undefined) {
    if (body.stream !== true) {
      throw new InputError('stream_options requires stream=true');
    }
    const options = body.stream_options;
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'include_usage') ||
      ((options as JsonObject).include_usage !== undefined &&
        typeof (options as JsonObject).include_usage !== 'boolean')
    ) {
      throw new InputError('stream_options supports only include_usage');
    }
  }
  if (body.modalities !== undefined) {
    if (
      !Array.isArray(body.modalities) ||
      body.modalities.length !== 1 ||
      body.modalities[0] !== 'text'
    ) {
      throw new InputError('Only text output is supported');
    }
  }
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (
      !format ||
      typeof format !== 'object' ||
      Array.isArray(format) ||
      (format as JsonObject).type !== 'text'
    ) {
      throw new InputError('Only text response_format is supported');
    }
  }
  return advisoryParameters;
}

function validateResponsesRequest(body: JsonObject): string[] {
  validateStream(body.stream);
  const advisoryParameters = validateAdvisoryParameters(body, [
    ['max_output_tokens', 'positiveInteger'],
  ]);
  if (!Object.hasOwn(body, 'input')) {
    throw new InputError('input is required');
  }
  if (body.store === true) {
    throw new InputError('Stored responses are not supported');
  }
  if (body.background === true) {
    throw new InputError('Background responses are not supported');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) {
    throw new InputError('Tool calling is not supported');
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'none') {
    throw new InputError('Only tool_choice="none" is supported');
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false) {
    throw new InputError('parallel_tool_calls is not supported');
  }
  if (body.truncation !== undefined && body.truncation !== 'disabled') {
    throw new InputError('Only truncation="disabled" is supported');
  }
  rejectPresent(body, [
    'previous_response_id',
    'conversation',
    'prompt',
    'max_tool_calls',
    'temperature',
    'top_p',
    'service_tier',
  ]);
  if (body.text !== undefined) {
    const text = body.text;
    if (!text || typeof text !== 'object' || Array.isArray(text)) {
      throw new InputError('text must be an object');
    }
    const format = (text as JsonObject).format;
    if (format !== undefined) {
      if (
        !format ||
        typeof format !== 'object' ||
        Array.isArray(format) ||
        (format as JsonObject).type !== 'text'
      ) {
        throw new InputError('Only plain text responses are supported');
      }
    }
  }
  return advisoryParameters;
}

function validateStream(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new InputError('stream must be a boolean');
  }
}

function parseChatReasoning(body: JsonObject): RequestedReasoning {
  const effort = normalizeReasoningEffort(body.reasoning_effort, 'reasoning_effort');
  const thinking = parseThinkingType(body.thinking);
  return {
    ...(effort ? { effort } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function parseResponsesReasoning(body: JsonObject): RequestedReasoning {
  const value = body.reasoning;
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('reasoning must be an object or null');
  }
  const reasoning = value as JsonObject;
  const unsupported = Object.keys(reasoning).find(
    (key) => key !== 'effort' && key !== 'summary',
  );
  if (unsupported) {
    throw new InputError('reasoning.' + unsupported + ' is not supported');
  }
  if (reasoning.summary !== undefined && reasoning.summary !== null) {
    throw new InputError('reasoning.summary is not supported');
  }
  const effort = normalizeReasoningEffort(reasoning.effort, 'reasoning.effort');
  return effort ? { effort } : {};
}

function parseThinkingType(value: unknown): RequestedReasoning['thinking'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('thinking must be an object or null');
  }
  const thinking = value as JsonObject;
  if (Object.keys(thinking).some((key) => key !== 'type')) {
    throw new InputError('thinking supports only type');
  }
  if (typeof thinking.type !== 'string') {
    throw new InputError('thinking.type must be enabled or disabled');
  }
  const type = thinking.type.trim().toLowerCase();
  if (type !== 'enabled' && type !== 'disabled') {
    throw new InputError('thinking.type must be enabled or disabled');
  }
  return type;
}

function rejectPresent(body: JsonObject, fields: string[]): void {
  const field = fields.find((name) => body[name] !== undefined && body[name] !== null);
  if (field) {
    throw new InputError(field + ' is not supported');
  }
}

type AdvisoryParameterKind = 'positiveInteger' | 'temperature' | 'probability';

function validateAdvisoryParameters(
  body: JsonObject,
  specifications: Array<readonly [string, AdvisoryParameterKind]>,
): string[] {
  const present: string[] = [];
  for (const [field, kind] of specifications) {
    const value = body[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (kind === 'positiveInteger') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new InputError(field + ' must be a positive integer or null');
      }
    } else if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (kind === 'temperature' ? value < 0 || value > 2 : value < 0 || value > 1)
    ) {
      throw new InputError(
        field +
          (kind === 'temperature'
            ? ' must be between 0 and 2 or null'
            : ' must be between 0 and 1 or null'),
      );
    }
    present.push(field);
  }
  return present;
}

function setAdvisoryParametersHeader(response: ServerResponse, fields: string[]): void {
  if (fields.length > 0) {
    response.setHeader('X-Codex-Bridge-Advisory-Parameters', fields.join(', '));
  }
}

function setReasoningHeaders(response: ServerResponse, prepared: PreparedGeneration): void {
  response.setHeader('X-Codex-Bridge-Reasoning-Effort', prepared.reasoningEffort);
  if (prepared.reasoningFallback) {
    response.setHeader('X-Codex-Bridge-Reasoning-Fallback', prepared.reasoningFallback);
  }
}

function sendChatCompletion(
  response: ServerResponse,
  content: string,
  model: string,
  usage: TokenUsage | null,
): void {
  sendJson(response, 200, {
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null, annotations: [] },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: toChatUsage(usage),
  });
}

async function streamChatCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  generations: GenerationService,
  prepared: PreparedGeneration,
  requestBody: JsonObject,
): Promise<void> {
  const id = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const abortController = requestAbortController(request, response);
  const includeUsage =
    (requestBody.stream_options as JsonObject | undefined)?.include_usage === true;
  let streamed = '';
  try {
    const result = await generations.generate(prepared, {
      signal: abortController.signal,
      onReady: () => {
        startSse(response);
        writeChatChunk(
          response,
          id,
          created,
          prepared.model.id,
          { role: 'assistant', content: '' },
          null,
        );
      },
      onDelta: (delta) => {
        streamed += delta;
        writeChatChunk(response, id, created, prepared.model.id, { content: delta }, null);
      },
    });
    if (!streamed && result.content) {
      streamed = result.content;
      writeChatChunk(response, id, created, result.model, { content: result.content }, null);
    }
    if (streamed !== result.content) {
      throw new Error('Codex streamed output did not match the final response');
    }
    writeChatChunk(response, id, created, result.model, {}, 'stop');
    if (includeUsage) {
      writeSseData(response, {
        id,
        object: 'chat.completion.chunk',
        created,
        model: result.model,
        choices: [],
        usage: toChatUsage(result.usage),
      });
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    if (!response.headersSent) {
      throw error;
    }
    if (!response.destroyed) {
      writeSseData(response, { error: streamErrorBody(error) });
      response.end();
    }
  }
}

function writeChatChunk(
  response: ServerResponse,
  id: string,
  created: number,
  model: string,
  delta: JsonObject,
  finishReason: string | null,
): void {
  writeSseData(response, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  });
}

async function streamResponse(
  request: IncomingMessage,
  response: ServerResponse,
  generations: GenerationService,
  prepared: PreparedGeneration,
  requestBody: JsonObject,
): Promise<void> {
  const ids = responseIds();
  const abortController = requestAbortController(request, response);
  let sequence = 0;
  let streamed = '';
  const event = (type: string, body: JsonObject) => {
    writeResponseEvent(response, {
      type,
      sequence_number: sequence++,
      ...body,
    });
  };
  try {
    const result = await generations.generate(prepared, {
      signal: abortController.signal,
      onReady: () => {
        startSse(response);
        event('response.created', {
          response: createResponseObject(
            ids,
            prepared.model.id,
            '',
            requestBody,
            prepared.reasoningEffort,
            'in_progress',
            null,
          ),
        });
        event('response.in_progress', {
          response: createResponseObject(
            ids,
            prepared.model.id,
            '',
            requestBody,
            prepared.reasoningEffort,
            'in_progress',
            null,
          ),
        });
        event('response.output_item.added', {
          output_index: 0,
          item: responseMessage(ids.messageId, '', 'in_progress'),
        });
        event('response.content_part.added', {
          item_id: ids.messageId,
          output_index: 0,
          content_index: 0,
          part: outputTextPart(''),
        });
      },
      onDelta: (delta) => {
        streamed += delta;
        event('response.output_text.delta', {
          item_id: ids.messageId,
          output_index: 0,
          content_index: 0,
          delta,
          logprobs: [],
        });
      },
    });
    if (!streamed && result.content) {
      streamed = result.content;
      event('response.output_text.delta', {
        item_id: ids.messageId,
        output_index: 0,
        content_index: 0,
        delta: result.content,
        logprobs: [],
      });
    }
    if (streamed !== result.content) {
      throw new Error('Codex streamed output did not match the final response');
    }
    event('response.output_text.done', {
      item_id: ids.messageId,
      output_index: 0,
      content_index: 0,
      text: result.content,
      logprobs: [],
    });
    event('response.content_part.done', {
      item_id: ids.messageId,
      output_index: 0,
      content_index: 0,
      part: outputTextPart(result.content),
    });
    event('response.output_item.done', {
      output_index: 0,
      item: responseMessage(ids.messageId, result.content, 'completed'),
    });
    event('response.completed', {
      response: createResponseObject(
        ids,
        result.model,
        result.content,
        requestBody,
        prepared.reasoningEffort,
        'completed',
        result.usage,
      ),
    });
    response.end();
  } catch (error) {
    if (!response.headersSent) {
      throw error;
    }
    if (!response.destroyed) {
      event('error', {
        code: 'codex_bridge_error',
        message: errorMessage(error),
        param: null,
      });
      event('response.failed', {
        response: createFailedResponse(
          ids,
          prepared.model.id,
          requestBody,
          prepared.reasoningEffort,
          error,
        ),
      });
      response.end();
    }
  }
}

interface ResponseIds {
  responseId: string;
  messageId: string;
  createdAt: number;
}

function responseIds(): ResponseIds {
  return {
    responseId: 'resp_' + randomUUID().replaceAll('-', ''),
    messageId: 'msg_' + randomUUID().replaceAll('-', ''),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function createResponseObject(
  ids: ResponseIds,
  model: string,
  content: string,
  requestBody: JsonObject,
  reasoningEffort: string,
  status: 'in_progress' | 'completed',
  usage: TokenUsage | null,
): JsonObject {
  const completed = status === 'completed';
  return {
    id: ids.responseId,
    object: 'response',
    created_at: ids.createdAt,
    status,
    completed_at: completed ? Math.floor(Date.now() / 1000) : null,
    error: null,
    incomplete_details: null,
    instructions: typeof requestBody.instructions === 'string' ? requestBody.instructions : null,
    max_output_tokens: null,
    model,
    output: completed ? [responseMessage(ids.messageId, content, 'completed')] : [],
    output_text: completed ? content : '',
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: reasoningEffort, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'none',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: completed ? toResponseUsage(usage) : null,
    metadata:
      requestBody.metadata && typeof requestBody.metadata === 'object'
        ? requestBody.metadata
        : {},
  };
}

function createFailedResponse(
  ids: ResponseIds,
  model: string,
  requestBody: JsonObject,
  reasoningEffort: string,
  error: unknown,
): JsonObject {
  return {
    ...createResponseObject(
      ids,
      model,
      '',
      requestBody,
      reasoningEffort,
      'in_progress',
      null,
    ),
    status: 'failed',
    completed_at: Math.floor(Date.now() / 1000),
    error: { code: 'codex_bridge_error', message: errorMessage(error) },
  };
}

function responseMessage(
  id: string,
  content: string,
  status: 'in_progress' | 'completed',
): JsonObject {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: status === 'completed' ? [outputTextPart(content)] : [],
  };
}

function outputTextPart(text: string): JsonObject {
  return { type: 'output_text', text, annotations: [], logprobs: [] };
}

function toChatUsage(usage: TokenUsage | null): JsonObject | null {
  if (!usage) {
    return null;
  }
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens, audio_tokens: 0 },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoningOutputTokens,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

function toResponseUsage(usage: TokenUsage | null): JsonObject | null {
  if (!usage) {
    return null;
  }
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens },
    total_tokens: usage.totalTokens,
  };
}

function requestAbortController(
  request: IncomingMessage,
  response: ServerResponse,
): AbortController {
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  response.once('close', () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });
  return controller;
}

function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
}

function writeSseData(response: ServerResponse, value: unknown): void {
  if (!response.destroyed && !response.writableEnded) {
    if (!response.write('data: ' + JSON.stringify(value) + '\n\n')) {
      throw new Error('SSE client is too slow');
    }
  }
}

function writeResponseEvent(response: ServerResponse, value: JsonObject): void {
  if (!response.destroyed && !response.writableEnded) {
    const frame =
      'event: ' + value.type + '\n' + 'data: ' + JSON.stringify(value) + '\n\n';
    if (!response.write(frame)) {
      throw new Error('SSE client is too slow');
    }
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed) {
    return;
  }
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

function toModelResponse(model: CodexModel): JsonObject {
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

function streamErrorBody(error: unknown): JsonObject {
  return {
    message: errorMessage(error),
    type: 'codex_bridge_error',
    code: 'codex_bridge_error',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const message = errorMessage(error);
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
