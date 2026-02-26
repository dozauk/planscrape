import Anthropic from '@anthropic-ai/sdk';

export type Priority = 'high' | 'medium' | 'low' | 'none';

export interface ClassifyResult {
  priority: Priority;
  reason: string;
}

/**
 * Returns true if both ANTHROPIC_API_KEY and CLASSIFICATION_PROMPT are set.
 * Used to gate classification-dependent behaviour (digest filtering, etc.).
 */
export function isClassificationEnabled(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY && process.env.CLASSIFICATION_PROMPT);
}

/**
 * Classify a single planning application using the LLM prompt stored in
 * CLASSIFICATION_PROMPT. Returns null if classification is not configured or
 * if the API call / parse fails — callers should treat null as "unclassified"
 * and not overwrite any previously stored priority.
 */
export async function classifyApplication(
  ref: string,
  council: string,
  description: string,
): Promise<ClassifyResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const promptTemplate = process.env.CLASSIFICATION_PROMPT;

  if (!apiKey || !promptTemplate) return null;

  const prompt = promptTemplate
    .replace('{{ref}}', ref)
    .replace('{{council}}', council)
    .replace('{{description}}', description);

  const client = new Anthropic({ apiKey });

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '';
    // Strip markdown code fences in case the model wraps the JSON
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(json) as { priority?: unknown; reason?: unknown };

    if (!['high', 'medium', 'low', 'none'].includes(String(parsed.priority))) {
      console.warn(`[classify] Unexpected priority "${parsed.priority}" for ${council}/${ref}`);
      return null;
    }

    return {
      priority: parsed.priority as Priority,
      reason: String(parsed.reason ?? '').slice(0, 500),
    };
  } catch (err) {
    console.warn(`[classify] Failed for ${council}/${ref}: ${err}`);
    return null;
  }
}
