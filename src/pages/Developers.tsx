import { useMemo, useState } from 'react';
import { DEFAULT_INPUT, estimateRefurb, type Spec } from '../engine/refurb';
import { gbp, gbpK, Section, Seg, Stat, Tag } from '../components/ui';

const ENDPOINTS = [
  { m: 'POST', p: '/v1/estimates/refurbishment', d: 'Trade/room-level refurb estimate with BoQ, ranges & assumptions', unit: '£0.40', status: 'MVP' },
  { m: 'POST', p: '/v1/analysis/investment', d: 'BTL / BRRR / flip / HMO underwriting incl. SDLT/LTT/LBTT, ICR', unit: '£0.25', status: 'MVP' },
  { m: 'GET', p: '/v1/tax/transaction', d: 'SDLT, LTT, LBTT + ADS with band breakdown & rate-table version', unit: '£0.02', status: 'MVP' },
  { m: 'POST', p: '/v1/valuations/rental', d: 'Rental estimate with comparables & confidence', unit: '£0.30', status: 'Phase 2' },
  { m: 'GET', p: '/v1/properties/{uprn}/constraints', d: 'Flood, conservation, Article 4, listed, planning history', unit: '£0.35', status: 'Phase 2' },
  { m: 'POST', p: '/v1/development/potential', d: 'Loft / extension / conversion feasibility (non-binding)', unit: '£0.60', status: 'Phase 3' },
  { m: 'POST', p: '/v1/chat/sessions', d: 'Grounded property assistant (tool-calling over the above)', unit: '£0.03/turn', status: 'Phase 3' },
  { m: 'GET', p: '/v1/portfolios/{id}/analytics', d: 'Portfolio yield, compliance, risk & refinance windows', unit: 'Seat', status: 'Phase 3' },
];

const USAGE = [3.1, 3.4, 3.2, 4.0, 4.4, 4.1, 5.0, 5.6, 5.2, 6.3, 6.9, 7.4, 7.1, 8.2];

export default function Developers() {
  const [brand, setBrand] = useState('#1f4e79');
  const [partner, setPartner] = useState('Acme Lettings');
  const [area, setArea] = useState(92);
  const [spec, setSpec] = useState<Spec>('standard');
  const [pc, setPc] = useState('E17 4QH');
  const est = useMemo(() => estimateRefurb({ ...DEFAULT_INPUT, postcode: pc, floorArea: area, spec }), [area, spec, pc]);
  const req = { postcode: pc, property_type: 'terraced', floor_area_m2: area, era: 'pre-1919', condition: 'poor', spec, scope: { preset: 'full_refurbishment' } };
  const res = { id: 'est_01JDEMO8Q', pricing_basis: est.basis, region: est.region, total_inc_vat: est.total, range: { low: est.low, high: est.high }, confidence: est.confidence, cost_per_m2_ex_vat: est.costPerM2, by_trade: est.byTrade.slice(0, 3).map((t) => ({ trade: t.trade, total: t.total })), '…': '', disclaimer: 'Indicative budget estimate; not a quotation.' };
  const embed = `<script src="https://cdn.plinth.example/widget/v1.js"\n  data-key="pk_live_…"\n  data-widget="refurb-estimate"\n  data-theme='{"brand":"${brand}","radius":12}'\n  data-partner-name="${partner}"></script>`;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">B2B infrastructure</div><h2 style={{ marginTop: 6 }}>API & white-label console</h2>
          <p className="muted" style={{ marginTop: 6 }}>The consumer app is the reference client. Partners get the same engines through versioned REST APIs, webhooks and embeddable widgets, isolated per tenant.</p></div>
        <div className="row"><Tag kind="demo">Sandbox tenant</Tag><Tag kind="neutral">OpenAPI 3.1 in /docs</Tag></div>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="API calls (14d)" value="74.2k" sub="p95 latency 210ms (target)" /></div>
        <div className="card"><Stat label="Metered spend MTD" value={gbp(1_846)} sub="Growth plan · £499 + usage" /></div>
        <div className="card"><Stat label="Widget conversions" value="6.1%" sub="Estimate → lead captured" /></div>
        <div className="card"><Stat label="Error rate" value="0.08%" sub="4xx excluded" /></div>
      </div>

      <div className="grid g2">
        <Section title="Try it: refurbishment estimate" kicker="Runs the real engine in your browser">
          <div className="grid g3" style={{ gap: 10 }}>
            <label className="field">Postcode<input className="input mono" value={pc} onChange={(e) => setPc(e.target.value)} /></label>
            <label className="field">Floor area m²<input className="input num" type="number" value={area} onChange={(e) => setArea(Math.max(20, Number(e.target.value) || 20))} /></label>
            <label className="field">Spec<Seg value={spec} onChange={setSpec} options={[{ value: 'budget', label: 'B' }, { value: 'standard', label: 'S' }, { value: 'premium', label: 'P' }]} /></label>
          </div>
          <pre className="code" style={{ marginTop: 12 }}>{`curl https://api.plinth.example/v1/estimates/refurbishment \\\n  -H "Authorization: Bearer sk_test_…" \\\n  -H "Idempotency-Key: 8c1e…" \\\n  -d '${JSON.stringify(req)}'`}</pre>
          <pre className="code" style={{ marginTop: 8, maxHeight: 260 }}>{JSON.stringify(res, null, 2)}</pre>
        </Section>
        <Section title="White-label widget" kicker="Embed on any partner site">
          <div className="grid g2" style={{ gap: 10 }}>
            <label className="field">Partner name<input className="input" value={partner} onChange={(e) => setPartner(e.target.value)} /></label>
            <label className="field">Brand colour<input className="input" type="color" value={brand} onChange={(e) => setBrand(e.target.value)} style={{ height: 40, padding: 4 }} /></label>
          </div>
          <div style={{ marginTop: 12, border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', background: '#fff', color: '#111' }}>
            <div style={{ background: brand, color: '#fff', padding: '10px 14px', fontWeight: 600 }}>{partner} · What will my renovation cost?</div>
            <div style={{ padding: 14 }}>
              <div style={{ fontSize: 13, color: '#555' }}>{area}m² · {pc} · {spec} specification</div>
              <div className="num" style={{ fontSize: 30, margin: '4px 0' }}>{gbpK(est.low)} – {gbpK(est.high)}</div>
              <div style={{ fontSize: 12, color: '#666' }}>Most likely {gbp(est.total)} incl. VAT</div>
              <button style={{ marginTop: 10, background: brand, color: '#fff', border: 0, borderRadius: 999, padding: '8px 14px', fontWeight: 600 }}>Get 3 verified quotes</button>
              <div style={{ fontSize: 10.5, color: '#888', marginTop: 10 }}>Powered by Plinth · indicative estimate</div>
            </div>
          </div>
          <pre className="code" style={{ marginTop: 12 }}>{embed}</pre>
        </Section>
      </div>

      <div className="split-r">
        <Section title="Endpoints & pricing" kicker="Usage-based">
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Endpoint</th><th>Description</th><th className="r">Per call</th><th>Status</th></tr></thead>
            <tbody>{ENDPOINTS.map((e) => <tr key={e.p}><td className="mono xs"><b>{e.m}</b> {e.p}</td><td className="small">{e.d}</td><td className="r num small">{e.unit}</td><td><Tag kind={e.status === 'MVP' ? 'ok' : 'neutral'}>{e.status}</Tag></td></tr>)}</tbody>
          </table></div>
        </Section>
        <div className="stack sticky" style={{ gap: 16 }}>
          <Section title="Calls / day (k)" kicker="Usage metering">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 110 }}>{USAGE.map((u, k) => <div key={k} style={{ flex: 1, height: `${(u / 8.2) * 100}%`, background: k === USAGE.length - 1 ? 'var(--accent)' : 'var(--ink)', borderRadius: 3, opacity: k === USAGE.length - 1 ? 1 : 0.75 }} title={`${u}k`} />)}</div>
          </Section>
          <Section title="Keys & security" kicker="Tenant: acme-lettings">
            <dl className="kv small">
              <dt>Publishable</dt><dd className="mono xs">pk_test_51…9QfA</dd>
              <dt>Secret</dt><dd className="mono xs">sk_test_••••••••3kd</dd>
              <dt>Allowed origins</dt><dd className="xs">acme-lettings.example</dd>
              <dt>Rate limit</dt><dd className="xs">50 req/s · burst 200</dd>
              <dt>Webhooks</dt><dd className="xs">estimate.completed, quote.received</dd>
              <dt>Data residency</dt><dd className="xs">UK (eu-west-2)</dd>
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
