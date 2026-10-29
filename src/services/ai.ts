// Optional AI drafting with the user's own Anthropic API key. The key stays in this device's
// local storage, is never included in backups, and nothing is sent until the user asks for a draft.

export const AI_KEY_STORAGE = 'mblj.anthropicKey';
export const AI_MODEL = 'claude-opus-5-5';

export function getAiKey(): string | null {
  try { return localStorage.getItem(AI_KEY_STORAGE); } catch { return null; }
}

const SYSTEM = [
  'You help an independent perfumer read their own lab journal.',
  'You receive two formula revisions, the batches made from them and timed smelling notes.',
  'Write a short, plain summary: what changed between the revisions, what the notes say at comparable batch ages and times after application, and which differences the data cannot support.',
  'Do not claim that a formula change caused a perceived difference; say when conditions differ (batch age, time since application, medium, sample strength).',
  'Do not give regulatory, safety or compliance conclusions.',
  'Keep material names exactly as written. Answer in the language requested.',
].join(' ');

export class AiError extends Error {}

/** Returns a draft for the user to read; it is never saved as a record automatically. */
export async function draftComparisonSummary(payload: unknown, language: string): Promise<string> {
  const key = getAiKey();
  if (!key) throw new AiError('no_key');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  try {
    const response = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Language: ${language}\n\nData (JSON):\n${JSON.stringify(payload)}` }],
    });
    if (response.stop_reason === 'refusal') throw new AiError('refused');
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    if (!text) throw new AiError('empty');
    return text;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('bad_key');
    if (e instanceof Anthropic.RateLimitError) throw new AiError('rate_limited');
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('offline');
    if (e instanceof Anthropic.APIError) throw new AiError(`api_${e.status ?? 'error'}`);
    throw e;
  }
}
