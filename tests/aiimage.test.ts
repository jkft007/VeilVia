import { describe, expect, it } from 'vitest';
import { AiImageError, configuredProviders, generateImage, MAX_PROMPT } from '../server/ai-image';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const b64 = Buffer.from(PNG).toString('base64');

interface Call {
  url: string;
  init?: RequestInit;
}
function fakeFetch(reply: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return reply(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('AI cover providers', () => {
  it('lists only fully configured providers, preferred one first', () => {
    expect(configuredProviders({})).toEqual([]);
    expect(configuredProviders({ AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_ENDPOINT: 'https://x' })).toEqual([]); // no deployment
    const all = { OPENAI_API_KEY: 'a', AZURE_OPENAI_API_KEY: 'b', AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com/', AZURE_OPENAI_IMAGE_DEPLOYMENT: 'img', GOOGLE_API_KEY: 'c', STABILITY_API_KEY: 'd' };
    expect(configuredProviders(all).map((p) => p.id)).toEqual(['openai', 'azure', 'gemini', 'stability']);
    expect(configuredProviders({ ...all, AI_IMAGE_PROVIDER: 'Gemini' }).map((p) => p.id)).toEqual(['gemini', 'openai', 'azure', 'stability']);
    expect(configuredProviders({ OPENAI_API_KEY: 'a', OPENAI_IMAGE_MODEL: 'dall-e-3' })[0].model).toBe('dall-e-3');
  });

  it('calls OpenAI with the key as a bearer token and decodes the image', async () => {
    const { f, calls } = fakeFetch(() => json({ data: [{ b64_json: b64 }] }));
    const img = await generateImage('openai', ' harbour ', { OPENAI_API_KEY: 'sk-test' }, f);
    expect([...img.bytes]).toEqual([...PNG]);
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({ model: 'gpt-image-1', prompt: 'harbour', size: '1536x1024' });
  });

  it('asks DALL-E for base64 and calls Azure by deployment with an api-key header', async () => {
    const { f, calls } = fakeFetch(() => json({ data: [{ b64_json: b64 }] }));
    await generateImage('openai', 'p', { OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'dall-e-3' }, f);
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({ response_format: 'b64_json', size: '1792x1024' });
    await generateImage('azure', 'p', { AZURE_OPENAI_API_KEY: 'az', AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com/', AZURE_OPENAI_IMAGE_DEPLOYMENT: 'my img' }, f);
    expect(calls[1].url).toBe('https://r.openai.azure.com/openai/deployments/my%20img/images/generations?api-version=2025-04-01-preview');
    expect((calls[1].init!.headers as Record<string, string>)['api-key']).toBe('az');
    expect(JSON.parse(String(calls[1].init!.body)).model).toBeUndefined();
  });

  it('reads Gemini inline image data and Stability raw bytes', async () => {
    const g = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] } }] }));
    const gi = await generateImage('gemini', 'p', { GEMINI_API_KEY: 'g' }, g.f);
    expect(gi.mime).toBe('image/jpeg');
    expect([...gi.bytes]).toEqual([...PNG]);
    expect((g.calls[0].init!.headers as Record<string, string>)['x-goog-api-key']).toBe('g');
    expect(g.calls[0].url).not.toContain('key=');

    const s = fakeFetch(() => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));
    const si = await generateImage('stability', 'p', { STABILITY_API_KEY: 's' }, s.f);
    expect([...si.bytes]).toEqual([...PNG]);
    expect(s.calls[0].url).toBe('https://api.stability.ai/v2beta/stable-image/generate/core');
    expect((s.calls[0].init!.body as FormData).get('prompt')).toBe('p');
  });

  it('reports provider errors briefly without echoing the key', async () => {
    const { f } = fakeFetch(() => json({ error: { message: 'Incorrect API key provided' } }, 401));
    const err = await generateImage('openai', 'p', { OPENAI_API_KEY: 'sk-secret-123' }, f).catch((e) => e);
    expect(err).toBeInstanceOf(AiImageError);
    expect(err.message).toMatch(/OpenAI: the API key was refused/);
    expect(err.message).not.toContain('sk-secret-123');
    const empty = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: 'no' }] } }] }));
    await expect(generateImage('gemini', 'p', { GEMINI_API_KEY: 'g' }, empty.f)).rejects.toThrow(/no image/);
  });

  it('refuses empty or overlong descriptions and unconfigured providers before calling anyone', async () => {
    const { f, calls } = fakeFetch(() => json({}));
    await expect(generateImage('openai', '  ', { OPENAI_API_KEY: 'k' }, f)).rejects.toThrow(/Describe/);
    await expect(generateImage('openai', 'x'.repeat(MAX_PROMPT + 1), { OPENAI_API_KEY: 'k' }, f)).rejects.toThrow(/under/);
    await expect(generateImage('stability', 'p', { OPENAI_API_KEY: 'k' }, f)).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });
});
