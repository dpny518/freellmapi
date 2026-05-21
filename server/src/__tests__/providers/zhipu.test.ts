import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZhipuProvider } from '../../providers/zhipu.js';

describe('ZhipuProvider', () => {
  let provider: ZhipuProvider;

  beforeEach(() => {
    provider = new ZhipuProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('zhipu');
    expect(provider.name).toBe('Zhipu AI');
  });

  it('should validate key against api.z.ai first and set base URL', async () => {
    let callCount = 0;
    let capturedUrls: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      callCount++;
      capturedUrls.push(String(url));
      if (String(url).includes('api.z.ai')) {
        return { status: 200 } as any;
      }
      return { status: 404 } as any;
    });

    const isValid = await provider.validateKey('valid-global-key');
    expect(isValid).toBe(true);
    expect(callCount).toBe(1);
    expect(capturedUrls[0]).toContain('api.z.ai/api/paas/v4/models');

    // Should route completions through the validated base URL
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url) => {
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'test response' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as any;
    });

    await provider.chatCompletion('valid-global-key', [], 'glm-4.5-flash');
  });

  it('should fall back to open.bigmodel.cn if api.z.ai fails', async () => {
    let callCount = 0;
    let capturedUrls: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      callCount++;
      capturedUrls.push(String(url));
      if (String(url).includes('open.bigmodel.cn')) {
        return { status: 200 } as any;
      }
      // api.z.ai fails
      throw new Error('Connection timeout');
    });

    const isValid = await provider.validateKey('valid-domestic-key');
    expect(isValid).toBe(true);
    expect(callCount).toBe(2);
    expect(capturedUrls[0]).toContain('api.z.ai/api/paas/v4/models');
    expect(capturedUrls[1]).toContain('open.bigmodel.cn/api/paas/v4/models');
  });

  it('should return false if both endpoints fail validation', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return { status: 401 } as any;
    });

    const isValid = await provider.validateKey('bad-key');
    expect(isValid).toBe(false);
  });
});
