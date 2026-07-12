export interface TranslationRequest {
  text: string | string[];
  model?: string;
  source?: string;
  source_lang?: string;
  target?: string;
  target_lang?: string;
  context?: string | string[];
  glossary?: Record<string, string>;
  style?: string;
}

export interface TranslationResult {
  translations: string[];
  cached: boolean[];
  durationMs: number;
  model: string;
}

export interface TranslationItem {
  key: string;
  model: string;
  runtimeModel: string;
  text: string;
  source: string;
  target: string;
  context: string[];
  glossary: Record<string, string>;
  style: string;
  placeholders: Array<{ marker: string; value: string }>;
}

export interface ChatMessage {
  role: string;
  content: unknown;
  name?: unknown;
}

export interface TextGenerationResult {
  content: string;
  model: string;
  usage: TokenUsage | null;
}

export interface RequestedReasoning {
  effort?: string;
  thinking?: 'enabled' | 'disabled';
}

export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface CodexModelSelection {
  id: string;
  model: string;
}

export interface CodexModel extends CodexModelSelection {
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  inputModalities?: string[];
}

export interface AppStatus {
  ready: boolean;
  authMode: string | null;
  planType: string | null;
  error?: string;
}
