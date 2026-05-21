import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions, type ProviderModel } from './base.js';

/**
 * Fold reasoning_content into content when content is null/empty.
 * Cloudflare reasoning models (kimi-k2, deepseek-r1-distill) return
 * the actual answer in `message.reasoning_content` with `content: null`.
 */
function normalizeResponse(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string;
      content: unknown;
    };
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
        msg.content = msg.reasoning_content;
      }
    }
  }
}

/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be in format "account_id:api_token"');
    return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
  }

  // Cloudflare's OpenAI-compat endpoint rejects `content: null` on assistant
  // messages that carry tool_calls, even though the OpenAI spec allows it.
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m =>
      m.content === null ? { ...m, content: '' } : m,
    );
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    normalizeResponse(data);
    data._routed_via = { platform: 'cloudflare', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
    //
    // cfat_ service tokens don't support /user/tokens/verify, so probe the
    // Workers AI endpoint with a cheap model instead.
    try {
      const { accountId, token } = this.parseKey(apiKey);
      const res = await this.fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: '@cf/meta/llama-3-8b-instruct',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
        },
        15000,
      );
      if (res.status === 401 || res.status === 403) return false;
      if (!res.ok) return true; // unexpected non-2xx that isn't auth — don't disable
      return true;
    } catch {
      return false;
    }
  }

  override async listModels(apiKey: string): Promise<ProviderModel[]> {
    const { accountId, token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=500`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
      15000,
    );
    if (!res.ok) return [];
    const data = await res.json() as { result?: Array<{ id: string; name: string; description?: string; context_window?: number; task?: { id: string; name: string }; properties?: Array<{ property_id: string; value: string }> }> };
    return (data.result ?? []).map(m => {
      const props: Record<string, string> = {};
      for (const p of m.properties ?? []) props[p.property_id] = p.value;
      const ctx = props.context_window ? parseInt(props.context_window, 10) : (m.context_window ?? NaN);
      return {
        id: m.name,
        name: m.name,
        description: m.description,
        contextWindow: isNaN(ctx) ? undefined : ctx,
        task: m.task?.name,
        properties: props,
      };
    });
  }
}
