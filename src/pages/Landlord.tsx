import { useMemo, useState } from 'react';
import { gbp, gbpK, Section, Spark, Stat, Tag } from '../components/ui';
import { AssistantPanel } from '../components/Assistant';
import { landlordSkills, maintenanceForecast, PORTFOLIO } from '../ai/landlordSkills';

const TODAY = new Date('2026-11-08');
const days = (d: string) => Math.round((new Date(d).getTime() - TODAY.getTime()) / 86_400_000);

const UNITS = [
  { id: 'U1', addr: '14 Arnside Terrace (fictional), L15', tenant: 'A. Okafor', rent: 1_050, paid: true, gas: '2027-02-11', eicr: '2029-06-01', epc: 'D', epcExp: '2031-03-01', deposit: 'DPS · protected', rtr: 'n/a (England check done 2024)', licence: '—', status: 'Let' },
  { id: 'U2', addr: 'Flat 3, Lace Market Yard (fictional), NG1', tenant: 'J. Whitfield', rent: 1_250, paid: false, gas: 'n/a (electric)', eicr: '2026-11-30', epc: 'B', epcExp: '2033-01-01', deposit: 'TDS · protected', rtr: 'Done', licence: 'Selective · 2028', status: 'Arrears 9 days' },
  { id: 'U3', addr: '22 Cranwell Street (fictional), M14 — 5-bed HMO', tenant: '5 sharers', rent: 3_625, paid: true, gas: '2026-11-19', eicr: '2027-09-14', epc: 'C', epcExp: '2030-05-01', deposit: 'mydeposits · 1 pending', rtr: '1 follow-up check due', licence: 'Mandatory HMO · 2029', status: 'Let (4/5)' },
  { id: 'U4', addr: '9 Bramwell Mount (fictional), LS6', tenant: '— void —', rent: 1_250, paid: false, gas: '2027-05-02', eicr: '2030-01-10', epc: 'D', epcExp: '2027-01-15', deposit: '—', rtr: '—', licence: '—', status: 'Void · 18 days' },
];

const TASKS0 = [
  { id: 'M-1042', unit: 'U3', title: 'Shower not draining, room 4', reported: '2026-11-06', stage: 'reported', triage: { trade: 'Plumbing', urgency: 'Routine (14 days)', confidence: 0.82 } },
  { id: 'M-1039', unit: 'U2', title: 'Black mould on bedroom wall', reported: '2026-11-03', stage: 'triaged', triage: { trade: 'Damp & mould inspection', urgency: 'Urgent — investigate within 14 days, hazard assessment', confidence: 0.91 } },
  { id: 'M-1031', unit: 'U1', title: 'Front door lock sticking', reported: '2026-10-28', stage: 'assigned', triage: { trade: 'Locksmith', urgency: 'Routine', confidence: 0.77 }, contractor: 'Mersey Locks (demo)' },
  { id: 'M-1020', unit: 'U3', title: 'Boiler pressure dropping', reported: '2026-10-19', stage: 'done', triage: { trade: 'Gas Safe engineer', urgency: 'Priority (72h)', confidence: 0.88 }, contractor: 'Northern Heat (demo)' },
];
type Stage = 'reported' | 'triaged' | 'assigned' | 'done';
const STAGES: { id: Stage; label: string }[] = [{ id: 'reported', label: 'Reported' }, { id: 'triaged', label: 'Triaged' }, { id: 'assigned', label: 'Contractor assigned' }, { id: 'done', label: 'Completed' }];

const APPS = [
  { name: 'Applicant A (redacted)', unit: 'U4', income: 'Affordability: 2.9× rent (declared)', refs: 'Landlord ref received', rtr: 'Share code verified', flags: [] as string[] },
  { name: 'Applicant B (redacted)', unit: 'U4', income: 'Affordability: 2.2× rent; guarantor offered', refs: 'Pending', rtr: 'Manual document check needed', flags: ['Below 2.5× guide — consider guarantor or rent in advance limits'] },
];

export default function Landlord() {
  const [tasks, setTasks] = useState(TASKS0);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const rentRoll = UNITS.reduce((s, u) => s + (u.status.startsWith('Void') ? 0 : u.rent), 0);
  const compliance = useMemo(() => {
    const items: { unit: string; item: string; due: string; d: number }[] = [];
    for (const u of UNITS) {
      if (/\d{4}/.test(u.gas)) items.push({ unit: u.id, item: 'Gas safety certificate (CP12) — annual', due: u.gas, d: days(u.gas) });
      items.push({ unit: u.id, item: 'EICR — 5-yearly', due: u.eicr, d: days(u.eicr) });
      items.push({ unit: u.id, item: `EPC expiry (current ${u.epc})`, due: u.epcExp, d: days(u.epcExp) });
    }
    items.push({ unit: 'U3', item: 'Deposit protection + prescribed information (within 30 days)', due: '2026-11-21', d: days('2026-11-21') });
    items.push({ unit: 'U3', item: 'Right to rent follow-up check (time-limited permission)', due: '2026-12-01', d: days('2026-12-01') });
    items.push({ unit: 'ALL', item: 'Smoke & CO alarms tested at start of each tenancy', due: '2026-11-15', d: days('2026-11-15') });
    return items.sort((a, b) => a.d - b.d);
  }, []);
  const move = (id: string, dir: 1 | -1) => setTasks((ts) => ts.map((t) => {
    if (t.id !== id) return t;
    const k = STAGES.findIndex((s) => s.id === t.stage);
    return { ...t, stage: STAGES[Math.max(0, Math.min(3, k + dir))].id };
  }));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Lettings & property management</div><h2 style={{ marginTop: 6 }}>Landlord dashboard</h2>
          <p className="muted" style={{ marginTop: 6 }}>Portfolio of 4 fictional units. Built around England’s Renters’ Rights Act regime: periodic assured tenancies, no section 21, annual section 13 rent increases.</p></div>
        <div className="row"><Tag kind="demo" /><Tag kind="live">Open banking rent feed · deposit scheme APIs</Tag></div>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="Monthly rent roll" value={gbp(rentRoll)} sub="Let units, contracted" /><Spark data={[8.1, 8.2, 8.2, 8.4, 8.3, 8.6, 8.7, 8.6, 8.9, 9.0, 8.9, 8.9]} height={36} color="var(--sage)" /></div>
        <div className="card"><Stat label="Arrears" value={gbp(1_250)} tone="neg" sub="1 tenancy · 9 days" /></div>
        <div className="card"><Stat label="Occupancy" value="81%" sub="9 of 11 lettable rooms/units" /></div>
        <div className="card"><Stat label="Compliance due ≤ 30 days" value={compliance.filter((c) => c.d <= 30).length} tone={compliance.some((c) => c.d < 14) ? 'neg' : undefined} sub="Auto-reminders to you & contractor" /></div>
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <AssistantPanel title="Ask about your portfolio" kicker="AI landlord intelligence" skills={landlordSkills} ctx={PORTFOLIO} />
          <Section title="Predictive maintenance & budget" kicker="Next 24 months" right={<Tag kind="est">From component ages</Tag>}>
            <div className="table-wrap" tabIndex={0}><table className="t"><thead><tr><th>Unit</th><th>Item</th><th>Expected</th><th className="r">Budget</th></tr></thead>
              <tbody>{maintenanceForecast().map((m, i) => <tr key={i}><td className="mono small">{m.unit}</td><td className="small">{m.item}</td><td className="small">{m.due}</td><td className="r num">{gbp(m.cost)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>Total forecast</td><td className="r num">{gbp(maintenanceForecast().reduce((s, m) => s + m.cost, 0))}</td></tr></tfoot></table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Based on verified installation dates and typical component lives; improves as maintenance records and invoices accumulate.</p>
          </Section>
          <Section title="Portfolio" kicker="Units">
            <div className="table-wrap" tabIndex={0}><table className="t">
              <thead><tr><th>Unit</th><th>Tenant</th><th className="r">Rent</th><th>Gas / EICR / EPC</th><th>Deposit · RTR · Licence</th><th>Status</th></tr></thead>
              <tbody>{UNITS.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.id}</b> <span className="small">{u.addr}</span></td>
                  <td className="small">{u.tenant}</td>
                  <td className="r num">{gbp(u.rent)}</td>
                  <td className="xs">{u.gas}<br />{u.eicr}<br />EPC {u.epc}</td>
                  <td className="xs">{u.deposit}<br />{u.rtr}<br />{u.licence}</td>
                  <td><Tag kind={u.status.startsWith('Let') ? 'ok' : 'warn'}>{u.status}</Tag></td>
                </tr>
              ))}</tbody>
            </table></div>
          </Section>

          <Section title="Maintenance" kicker="Tenant-reported · AI triage, human-assigned" right={<Tag kind="ai">Triage suggestions</Tag>}>
            <div className="kanban">
              {STAGES.map((s) => (
                <div key={s.id} className="kcol">
                  <div className="row between"><b className="small">{s.label}</b><span className="xs muted">{tasks.filter((t) => t.stage === s.id).length}</span></div>
                  {tasks.filter((t) => t.stage === s.id).map((t) => (
                    <div key={t.id} className="kcard">
                      <div className="row between"><span className="mono xs muted">{t.id} · {t.unit}</span><span className="xs muted">{t.reported.slice(5)}</span></div>
                      <div style={{ fontWeight: 600, margin: '4px 0' }}>{t.title}</div>
                      <div className="xs"><Tag kind="ai">{t.triage.trade}</Tag> <span className="muted">{Math.round(t.triage.confidence * 100)}%</span></div>
                      <div className="xs muted" style={{ marginTop: 4 }}>{t.triage.urgency}</div>
                      {'contractor' in t && t.contractor && <div className="xs" style={{ marginTop: 4 }}>→ {t.contractor}</div>}
                      <div className="row" style={{ marginTop: 8, gap: 6 }}>
                        {s.id !== 'reported' && <button className="btn ghost sm" onClick={() => move(t.id, -1)}>←</button>}
                        {s.id !== 'done' && <button className="btn sm" onClick={() => move(t.id, 1)}>{s.id === 'reported' ? 'Confirm triage' : s.id === 'triaged' ? 'Assign' : 'Complete'} →</button>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="xs muted" style={{ marginTop: 8 }}>Damp & mould reports are always escalated for prompt investigation and hazard assessment (HHSRS). Streetkey suggests trade and urgency; the landlord or agent confirms.</p>
          </Section>

          <Section title="Applications for U4" kicker="Human decision required" right={<Tag kind="neutral">No automated refusals</Tag>}>
            <div className="stack">
              {APPS.map((a) => (
                <div key={a.name} className="card flat" style={{ padding: 12 }}>
                  <div className="row between"><b>{a.name}</b>{decisions[a.name] && <Tag kind={decisions[a.name] === 'Proceed to offer' ? 'ok' : 'neutral'}>{decisions[a.name]}</Tag>}</div>
                  <div className="small muted" style={{ marginTop: 4 }}>{a.income} · {a.refs} · Right to rent: {a.rtr}</div>
                  {a.flags.map((f) => <div key={f} className="xs" style={{ color: 'var(--gold)', marginTop: 4 }}>ⓘ {f}</div>)}
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={() => setDecisions((d) => ({ ...d, [a.name]: 'Proceed to offer' }))}>Proceed</button>
                    <button className="btn ghost sm" onClick={() => setDecisions((d) => ({ ...d, [a.name]: 'More information requested' }))}>Request info</button>
                  </div>
                </div>
              ))}
            </div>
            <p className="xs muted" style={{ marginTop: 8 }}>Screening shows facts, not scores. Protected characteristics and benefit status are never used (blanket “No DSS”/children/pet bans are unlawful under the Renters’ Rights Act regime). Every decision is logged with reason and the human who made it (UK GDPR Art. 22).</p>
          </Section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <Section title="Compliance calendar" kicker="Next 12 months">
            <ul className="clean">{compliance.slice(0, 9).map((c, k) => (
              <li key={k} className="row between" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <div className="small"><b className="mono xs">{c.unit}</b> {c.item}<div className="xs muted">{c.due}</div></div>
                <Tag kind={c.d < 0 ? 'warn' : c.d <= 30 ? 'warn' : c.d <= 90 ? 'demo' : 'ok'}>{c.d < 0 ? 'Overdue' : `${c.d}d`}</Tag>
              </li>
            ))}</ul>
          </Section>
          <Section title="Rent review (section 13)" kicker="U1 · Arnside Terrace">
            <div className="row between"><Stat label="Current" value={gbp(1_050)} /><Stat label="Market evidence" value={gbp(1_095)} sub="4 demo let comps" /></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Increases limited to once per year via section 13 notice (2 months), challengeable at the First-tier Tribunal. Streetkey drafts the notice with comparable evidence for you to review.</p>
          </Section>
          <Section title="Void cost" kicker="U4 · 18 days">
            <div className="num" style={{ fontSize: 24 }}>{gbpK(18 * (1_250 * 12) / 365 + 18 * 6)}</div>
            <div className="xs muted">Lost rent + council tax & utilities so far. Listing syndicated to Streetkey Discover; 6 enquiries, 3 viewings booked.</div>
          </Section>
          <div className="callout info xs">Regulatory content reflects England as configured Nov 2026 (Renters’ Rights Act 2025 tenancy reforms from 1 May 2026; PRS Database & Ombudsman to follow). Wales (Renting Homes Act) and Scotland (PRT) rule-sets are separate modules. Not legal advice — verify current commencement status.</div>
        </div>
      </div>
    </div>
  );
}
