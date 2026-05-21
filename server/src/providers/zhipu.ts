import { OpenAICompatProvider } from './openai-compat.js';

/**
 * Custom provider for Zhipu AI / Z.ai.
 * Automatically detects whether to use the global endpoint (api.z.ai) or the domestic
 * Chinese endpoint (open.bigmodel.cn) based on which one accepts the API key during validation.
 */
export class ZhipuProvider extends OpenAICompatProvider {
  private activeUrls = new Map<string, string>();

  constructor() {
    super({
      platform: 'zhipu',
      name: 'Zhipu AI',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', // Fallback default
    });
  }

  protected override getBaseUrl(apiKey: string): string {
    return this.activeUrls.get(apiKey) ?? 'https://api.z.ai/api/paas/v4';
  }

  override async validateKey(apiKey: string): Promise<boolean> {
    // 1. Try global endpoint (api.z.ai)
    try {
      const res = await this.fetchWithTimeout('https://api.z.ai/api/paas/v4/models', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }, 5000);
      if (res.status === 200) {
        this.activeUrls.set(apiKey, 'https://api.z.ai/api/paas/v4');
        return true;
      }
    } catch {
      // Ignore network errors and try fallback
    }

    // 2. Try domestic/CN endpoint (open.bigmodel.cn)
    try {
      const res = await this.fetchWithTimeout('https://open.bigmodel.cn/api/paas/v4/models', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }, 5000);
      if (res.status === 200) {
        this.activeUrls.set(apiKey, 'https://open.bigmodel.cn/api/paas/v4');
        return true;
      }
      return res.status !== 401 && res.status !== 403;
    } catch {
      // Ignore
    }

    return false;
  }
}
