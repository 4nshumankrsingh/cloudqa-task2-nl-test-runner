// The ONLY file that knows which AI provider is in use.
import { firstLine } from './types.js';

export type ToolSpec = { name: string; description: string; schema: Record<string, unknown> };
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export interface LlmClient {
  readonly label: string;
  /** Asks the model to answer by calling `tool`, and returns the tool arguments. */
  callTool(system: string, messages: ChatMessage[], tool: ToolSpec): Promise<unknown>;
}

type Env = Record<string, string | undefined>;

// Providers that speak the OpenAI "chat completions" protocol, with default endpoints.
const OPENAI_COMPATIBLE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

function build(provider: string, key: string, model: string, env: Env): LlmClient {
  if (provider === 'anthropic') return new AnthropicClient(key, model);
  const baseUrl = env.LLM_BASE_URL?.trim() || OPENAI_COMPATIBLE[provider];
  if (baseUrl) {
    return new OpenAiCompatClient(provider, key, model, baseUrl, env.LLM_REASONING_EFFORT?.trim());
  }
  throw new Error(`Unknown LLM_PROVIDER '${provider}'. Use anthropic, openai, gemini, groq or openrouter.`);
}

export function createLlm(env: Env = process.env): LlmClient {
  const provider = (env.LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const key = env.LLM_API_KEY?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!key) throw new Error('LLM_API_KEY is not set. Copy .env.example to .env and fill it in.');
  if (!model) throw new Error("LLM_MODEL is not set. Copy a model name from your provider's list.");

  const primary = build(provider, key, model, env);
  const backupModel = env.LLM_FALLBACK_MODEL?.trim();
  return backupModel ? new FallbackClient(primary, build(provider, key, backupModel, env)) : primary;
}

// If the main model fails (after its own retries), the rest of the run uses the backup model.
class FallbackClient implements LlmClient {
  readonly label: string;
  private useBackup = false;
  constructor(private primary: LlmClient, private backup: LlmClient) {
    this.label = `${primary.label} (backup: ${backup.label})`;
  }

  async callTool(system: string, messages: ChatMessage[], tool: ToolSpec): Promise<unknown> {
    if (!this.useBackup) {
      try {
        return await this.primary.callTool(system, messages, tool);
      } catch (e) {
        console.warn(`  Main model failed (${firstLine(e)}). Switching to ${this.backup.label}.`);
        this.useBackup = true;
      }
    }
    return this.backup.callTool(system, messages, tool);
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError') return 'no answer within the time limit';
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return detail ? `${e.message} (${detail})` : e.message;
  }
  return String(e);
}

// Each attempt has a time limit. Timeouts, network errors, 429 and 5xx are retried with a short backoff.
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const maxAttempts = 4;
  const timeoutMs = (Number(process.env.LLM_TIMEOUT_SECONDS) || 45) * 1000;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryable = true;
    let retryAfterSeconds = 0;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      retryable = res.status === 429 || res.status >= 500;
      retryAfterSeconds = Number(res.headers.get('retry-after')) || 0;
    } catch (e) {
      lastError = `no usable answer: ${describeError(e)}`;
    }
    if (!retryable || attempt === maxAttempts) break;
    const waitSeconds = Math.min(retryAfterSeconds || 2 ** attempt, 30);
    console.warn(`  Model not answering (${lastError.slice(0, 80)}). Retry ${attempt}/${maxAttempts - 1} in ${waitSeconds}s...`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
  throw new Error(`LLM request failed. ${lastError}`);
}

function parseJsonLoose(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Model reply contained no JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

class AnthropicClient implements LlmClient {
  readonly label: string;
  constructor(private key: string, private model: string) {
    this.label = `anthropic:${model}`;
  }

  async callTool(system: string, messages: ChatMessage[], tool: ToolSpec): Promise<unknown> {
    const data = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: 1024,
        system,
        messages,
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
        tool_choice: { type: 'tool', name: tool.name },
      },
    );
    const block = (data.content ?? []).find((b: any) => b.type === 'tool_use');
    if (!block) throw new Error('Model did not return a tool call.');
    return block.input;
  }
}

class OpenAiCompatClient implements LlmClient {
  readonly label: string;
  private model: string;
  constructor(
    provider: string,
    private key: string,
    model: string,
    private baseUrl: string,
    private reasoningEffort?: string,
  ) {
    this.model = model.replace(/^models\//, ''); // some model lists prefix names with "models/"
    this.label = `${provider}:${this.model}`;
  }

  async callTool(system: string, messages: ChatMessage[], tool: ToolSpec): Promise<unknown> {
    const data = await postJson(
      `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      { authorization: `Bearer ${this.key}` },
      {
        model: this.model,
        messages: [{ role: 'system', content: system }, ...messages],
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
        tool_choice: 'required', // only one tool is offered, so this forces it
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      },
    );
    const msg = data.choices?.[0]?.message;
    const call = msg?.tool_calls?.[0];
    if (call?.function?.arguments) return JSON.parse(call.function.arguments);
    if (typeof msg?.content === 'string') return parseJsonLoose(msg.content); // fallback if tools are ignored
    throw new Error('Model did not return a tool call or JSON.');
  }
}