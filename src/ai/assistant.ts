/**
 * Brixo assistant framework.
 *
 * Every answer is a structured object: text + evidence + assumptions + what
 * must be verified + confidence + which deterministic tools produced it.
 *
 * PROTOTYPE: intents are routed by pattern matching to "skills" (functions
 * over the engines). PRODUCTION: an LLM selects the same skills via tool
 * calling and writes the prose; a grounding check rejects any number in the
 * prose that the tools did not return. The skills — and therefore the facts —
 * are identical in both modes.
 */
export type Confidence = 'low' | 'medium' | 'high';

export interface AiAnswer {
  text: string;
  evidence: string[];
  assumptions: string[];
  verify: string[];
  confidence: Confidence;
  tools: string[];
  link?: { label: string; to: string };
}

export interface Skill<C> {
  id: string;
  label: string;          // suggested prompt shown as a chip
  match: RegExp;
  run: (ctx: C, question: string) => AiAnswer;
}

export function route<C>(skills: Skill<C>[], ctx: C, question: string): AiAnswer & { skill: string } {
  const s = skills.find((k) => k.match.test(question));
  if (!s) {
    return {
      skill: 'fallback', confidence: 'low', tools: [], evidence: [], assumptions: [], verify: [],
      text: `I can answer questions like: ${skills.slice(0, 5).map((k) => `“${k.label}”`).join(', ')}. I only answer from Brixo's calculations and the data shown here, so I won't guess beyond that.`,
    };
  }
  return { skill: s.id, ...s.run(ctx, question) };
}

/** Grounding check used in production on LLM prose: every £ figure must appear in tool output. */
export function ungroundedFigures(prose: string, toolOutputs: string): string[] {
  const nums = prose.match(/£[\d,.]+k?m?/g) ?? [];
  const norm = (s: string) => s.replace(/[£,]/g, '');
  return nums.filter((n) => !norm(toolOutputs).includes(norm(n)));
}
