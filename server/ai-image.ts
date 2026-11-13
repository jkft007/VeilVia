// AI-generated cover photos, for local use with `npm run dev`.
// API keys are read from .env on the machine running Vite and used only here, on the server side: they are never sent to
// the browser and never end up in the built site. The browser sends only the picture's description, never a secret, and
// gets back the image. The published static site has no such endpoint, so the feature is simply absent there.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';

export type ProviderId = 'openai' | 'azure' | 'gemini' | 'stability';
export type Env = Record<string, string | undefined>;
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  model: string;
}
export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
}
type Fetch = typeof fetch;

export class AiImageError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export const MAX_PROMPT = 1000;
const ORDER: ProviderId[] = ['openai', 'azure', 'gemini', 'stability'];
const v = (env: Env, k: string) => env[k]?.trim() || '';

const settings = (env: Env) => ({
  openai: { key: v(env, 'OPENAI_API_KEY'), model: v(env, 'OPENAI_IMAGE_MODEL') || 'gpt-image-1', base: (v(env, 'OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/+$/, '') },
  azure: {
    key: v(env, 'AZURE_OPENAI_API_KEY'),
    endpoint: v(env, 'AZURE_OPENAI_ENDPOINT').replace(/\/+$/, ''),
    deployment: v(env, 'AZURE_OPENAI_IMAGE_DEPLOYMENT'),
    version: v(env, 'AZURE_OPENAI_API_VERSION') || '2025-04-01-preview',
  },
  gemini: { key: v(env, 'GEMINI_API_KEY') || v(env, 'GOOGLE_API_KEY'), model: v(env, 'GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-image' },
  stability: { key: v(env, 'STABILITY_API_KEY'), model: v(env, 'STABILITY_IMAGE_MODEL') || 'core' },
});

/** The providers that have everything they need in the environment, the preferred one (AI_IMAGE_PROVIDER) first. */
export function configuredProviders(env: Env): ProviderInfo[] {
  const s = settings(env);
  const out: ProviderInfo[] = [];
  if (s.openai.key) out.push({ id: 'openai', label: 'OpenAI', model: s.openai.model });
  if (s.azure.key && s.azure.endpoint && s.azure.deployment) out.push({ id: 'azure', label: 'Azure OpenAI', model: s.azure.deployment });
  if (s.gemini.key) out.push({ id: 'gemini', label: 'Google Gemini', model: s.gemini.model });
  if (s.stability.key) out.push({ id: 'stability', label: 'Stability AI', model: s.stability.model });
  const pref = v(env, 'AI_IMAGE_PROVIDER').toLowerCase();
  out.sort((a, b) => (b.id === pref ? 1 : 0) - (a.id === pref ? 1 : 0) || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return out;
}

const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** A short, safe message from a provider's error reply (never the request, so never the key). */
async function failure(res: Response, who: string): Promise<AiImageError> {
  let detail = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = j?.error?.message ?? j?.message ?? (Array.isArray(j?.errors) ? j.errors.join(' ') : '') ?? '';
    } catch {
      detail = t;
    }
  } catch {
    /* no body */
  }
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 300);
  const why = res.status === 401 || res.status === 403 ? 'the API key was refused' : res.status === 429 ? 'rate limited or out of credit' : `HTTP ${res.status}`;
  return new AiImageError(`${who}: ${why}${detail ? ` (${detail})` : ''}.`, res.status === 400 ? 400 : 502);
}

/** OpenAI-style images API (OpenAI and Azure OpenAI share it). */
async function openAiStyle(f: Fetch, url: string, headers: Record<string, string>, model: string | undefined, prompt: string, who: string): Promise<GeneratedImage> {
  const dalle = !!model?.startsWith('dall-e');
  const body: Record<string, unknown> = { prompt, n: 1, size: dalle ? '1792x1024' : '1536x1024' };
  if (model) body.model = model;
  if (dalle) body.response_format = 'b64_json';
  const res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res, who);
  const j = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const d = j.data?.[0];
  if (d?.b64_json) return { bytes: fromB64(d.b64_json), mime: 'image/png' };
  if (d?.url) {
    const img = await f(d.url);
    if (!img.ok) throw new AiImageError(`${who}: could not download the generated image.`);
    return { bytes: new Uint8Array(await img.arrayBuffer()), mime: img.headers.get('content-type') || 'image/png' };
  }
  throw new AiImageError(`${who}: the reply held no image.`);
}

/** Generates one landscape picture from a description. */
export async function generateImage(id: ProviderId, prompt: string, env: Env, f: Fetch = fetch): Promise<GeneratedImage> {
  prompt = prompt.trim();
  if (!prompt) throw new AiImageError('Describe the picture first.', 400);
  if (prompt.length > MAX_PROMPT) throw new AiImageError(`Keep the description under ${MAX_PROMPT} characters.`, 400);
  if (!configuredProviders(env).some((p) => p.id === id)) throw new AiImageError('That AI provider is not configured in .env.', 400);
  const s = settings(env);
  switch (id) {
    case 'openai':
      return openAiStyle(f, `${s.openai.base}/images/generations`, { Authorization: `Bearer ${s.openai.key}` }, s.openai.model, prompt, 'OpenAI');
    case 'azure':
      return openAiStyle(
        f,
        `${s.azure.endpoint}/openai/deployments/${encodeURIComponent(s.azure.deployment)}/images/generations?api-version=${encodeURIComponent(s.azure.version)}`,
        { 'api-key': s.azure.key },
        undefined,
        prompt,
        'Azure OpenAI',
      );
    case 'gemini': {
      const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.gemini.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.gemini.key },
        body: JSON.stringify({ contents: [{ parts: [{ text: `${prompt}\n\nLandscape orientation, 3:2.` }] }] }),
      });
      if (!res.ok) throw await failure(res, 'Google Gemini');
      const j = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }[] } }[] };
      for (const p of j.candidates?.[0]?.content?.parts ?? []) {
        const d = p.inlineData ?? (p.inline_data && { data: p.inline_data.data, mimeType: p.inline_data.mime_type });
        if (d?.data) return { bytes: fromB64(d.data), mime: d.mimeType || 'image/png' };
      }
      throw new AiImageError('Google Gemini: the reply held no image (the model may have declined the description).');
    }
    case 'stability': {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('aspect_ratio', '3:2');
      form.append('output_format', 'png');
      const res = await f(`https://api.stability.ai/v2beta/stable-image/generate/${encodeURIComponent(s.stability.model)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.stability.key}`, Accept: 'image/*' },
        body: form,
      });
      if (!res.ok) throw await failure(res, 'Stability AI');
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'image/png' };
    }
  }
}

// ---- the Vite middleware --------------------------------------------------------------
export const AI_HEADER = 'x-veilvia-ai'; // a custom header, so other websites cannot call this without a CORS preflight (which is never answered)

function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new AiImageError('Request too large.', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

export function aiImagePlugin(): Plugin {
  let env: Env = {};
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!/\/api\/ai-image(\/providers)?$/.test(path)) return next();
    if (req.headers[AI_HEADER] !== '1') return sendJson(res, 403, { error: 'Forbidden.' });
    try {
      if (path.endsWith('/providers')) return sendJson(res, 200, { providers: configuredProviders(env) });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      const body = JSON.parse(await readBody(req)) as { provider?: ProviderId; prompt?: string };
      const img = await generateImage(body.provider as ProviderId, String(body.prompt ?? ''), env);
      res.statusCode = 200;
      res.setHeader('Content-Type', img.mime);
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(img.bytes));
    } catch (e) {
      const err = e instanceof AiImageError ? e : new AiImageError(e instanceof SyntaxError ? 'Bad request.' : 'Could not reach the AI provider.', e instanceof SyntaxError ? 400 : 502);
      sendJson(res, err.status, { error: err.message });
    }
  };
  return {
    name: 'ai-image',
    configResolved(config) {
      env = { ...loadEnv(config.mode, config.envDir || config.root, ''), ...process.env };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handler(req, res, next));
    },
  };
}
