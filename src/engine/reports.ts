/** Report generators: deterministic Markdown built from engine outputs. */
import type { Property } from '../data/properties';
import { benchmark, engagementFor, insightsFor, PERIOD_DAYS, PERIOD_END, totals } from './engagement';
import { valuationScenario } from './valuation';

const pc = (n: number) => `${(n * 100).toFixed(1)}%`;
const g = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;

export function weeklyOwnerReport(p: Property, audience: 'owner' | 'agent-draft' = 'owner'): string {
  const e = engagementFor(p); const all = totals(e); const wk = totals(e, 21, 28); const prev = totals(e, 14, 21);
  const bm = benchmark(p); const v = valuationScenario(p); const ins = insightsFor(p);
  const photos = [...e.photos].sort((a, b) => b.enlargements / b.impressions - a.enlargements / a.impressions);
  const lines = [
    `# Weekly listing report — ${p.street.replace(' (fictional)', '')}, ${p.town}`,
    `Week ending ${PERIOD_END} · ${audience === 'agent-draft' ? 'DRAFT for agent approval' : 'Prepared by Streetkey'}`,
    '',
    '> Engagement figures in this prototype are simulated demonstration data. Estimates are indicative and are not a RICS valuation.',
    '',
    '## This week at a glance',
    `| Metric | This week | Previous week | ${PERIOD_DAYS} days |`, '|---|---|---|---|',
    `| Views | ${wk.views} | ${prev.views} | ${all.views} |`,
    `| Unique visitors | ${wk.unique} | ${prev.unique} | ${all.unique} |`,
    `| Saves | ${wk.saves} | ${prev.saves} | ${all.saves} |`,
    `| Viewing requests | ${wk.viewingRequests} | ${prev.viewingRequests} | ${all.viewingRequests} |`,
    `| Enquiries | ${wk.enquiries} | ${prev.enquiries} | ${all.enquiries} |`,
    '',
    `Conversion (enquiries + viewing requests ÷ unique visitors): **${pc(all.enquiryRate.p)}** (95% CI ${pc(all.enquiryRate.low)}–${pc(all.enquiryRate.high)}) vs **${pc(bm.rate.p)}** for ${bm.n} comparable listings.`,
    '',
    '## What buyers engage with (observed)',
    ...photos.slice(0, 3).map((ph) => `- Photo “${ph.label}”: enlarged by ${pc(ph.enlargements / ph.impressions)} of viewers`),
    `- Most-asked AI questions: ${e.aiQuestions.slice(0, 3).map((q) => `${q.topic} (${q.count})`).join(', ')}`,
    `- ${e.refurbSimulations} renovation simulations; most-explored style: ${e.designStyles[0].style}`,
    '',
    '## Pricing evidence',
    `Asking ${g(p.price)} · indicative as-is range ${g(v.asIs.low)}–${g(v.asIs.high)} (${v.verdict}, ${v.confidence} confidence, ${v.evidenceCount} sold comparables).`,
    '',
    '## Recommendations',
    ...ins.filter((i) => i.kind !== 'observed').map((i) => `- **${i.title}** (${i.kind}, ${i.confidence} confidence)\n  - Evidence: ${i.evidence.join('; ')}${i.caveat ? `\n  - Caveat: ${i.caveat}` : ''}`),
    '',
    '_Privacy: all figures are aggregated; groups smaller than 10 visitors are suppressed. No individual visitor is identified._',
  ];
  return lines.join('\n');
}
