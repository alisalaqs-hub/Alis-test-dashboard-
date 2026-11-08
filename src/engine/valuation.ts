/**
 * Indicative valuation scenarios from comparable evidence. NOT a valuation:
 * Brixo is not RICS-regulated and this is a transparent comparison method so
 * users can see what is driving the number. Production replaces the demo
 * comparables with HM Land Registry Price Paid + EPC floor areas.
 */
import type { Property } from '../data/properties';
import { estimateRefurb } from './refurb';
import { refurbInputFor } from './insights';

export interface ValuationScenario {
  asIs: { low: number; mid: number; high: number };
  postWorks: { low: number; mid: number; high: number };
  method: string[];
  evidenceCount: number;
  confidence: 'low' | 'medium' | 'high';
  verdict: 'below range' | 'within range' | 'above range' | 'insufficient evidence';
  askingVsMid: number;
}

const r1k = (n: number) => Math.round(n / 1000) * 1000;

export function valuationScenario(p: Property): ValuationScenario {
  // Only like-for-like evidence: sold, within ±2 bedrooms (unit sales from conversions are excluded).
  const sold = p.comparables.filter((c) => c.kind === 'sold' && Math.abs(c.beds - p.beds) <= 2);
  const refurbCost = estimateRefurb(refurbInputFor(p)).total;
  const method: string[] = [];
  // Bedroom adjustment: ~7% per bedroom difference (demo heuristic, to be replaced by hedonic model).
  const adj = (price: number, beds: number) => price * (1 + 0.07 * (p.beds - beds));
  const unref = sold.filter((c) => !c.refurbished).map((c) => adj(c.price, c.beds));
  const ref = sold.filter((c) => c.refurbished).map((c) => adj(c.price, c.beds));
  const postMid = ref.length ? ref.reduce((a, b) => a + b, 0) / ref.length : p.estGdv;
  method.push(ref.length ? `Post-works value from ${ref.length} refurbished sold comparable(s), adjusted ±7% per bedroom difference.` : 'No refurbished sold comparables: post-works value taken from the listing model estimate.');
  // As-is: direct unrefurbished evidence where available, blended with residual (post-works − refurb − 12% buyer margin for risk/hassle).
  const residual = postMid - refurbCost - postMid * 0.12;
  let asIsMid: number;
  if (unref.length) {
    const direct = unref.reduce((a, b) => a + b, 0) / unref.length;
    asIsMid = direct * 0.6 + residual * 0.4;
    method.push(`As-is value blends ${unref.length} unrefurbished comparable(s) (60%) with a residual check (40%): post-works value − refurb estimate £${r1k(refurbCost).toLocaleString('en-GB')} − 12% margin for buyer risk.`);
  } else {
    asIsMid = residual;
    method.push(`As-is value by residual only: post-works value − refurb estimate £${r1k(refurbCost).toLocaleString('en-GB')} − 12% margin for buyer risk.`);
  }
  const evidenceCount = sold.length;
  const spread = evidenceCount >= 3 ? 0.05 : evidenceCount === 2 ? 0.07 : 0.1;
  const confidence = evidenceCount >= 3 ? 'medium' : 'low'; // never 'high' without verified, measured comparables
  const asIs = { low: r1k(asIsMid * (1 - spread)), mid: r1k(asIsMid), high: r1k(asIsMid * (1 + spread)) };
  const postWorks = { low: r1k(postMid * (1 - spread)), mid: r1k(postMid), high: r1k(postMid * (1 + spread)) };
  const verdict = evidenceCount === 0 ? 'insufficient evidence' : p.price > asIs.high ? 'above range' : p.price < asIs.low ? 'below range' : 'within range';
  method.push('Not a RICS valuation. Comparables are demonstration data; production uses Land Registry sold prices with EPC floor areas.');
  return { asIs, postWorks, method, evidenceCount, confidence, verdict, askingVsMid: (p.price - asIs.mid) / asIs.mid };
}

/** Rental estimate from let comparables, else listing model, with range. */
export function rentalScenario(p: Property) {
  const lets = p.comparables.filter((c) => c.kind === 'let' && c.beds === p.beds);
  const mid = lets.length ? lets.reduce((a, c) => a + c.price, 0) / lets.length : p.estRentPcm;
  const spread = lets.length ? 0.05 : 0.1;
  return { low: Math.round(mid * (1 - spread) / 25) * 25, mid: Math.round(mid / 25) * 25, high: Math.round(mid * (1 + spread) / 25) * 25, evidence: lets.length, basis: lets.length ? `${lets.length} let comparable(s) with ${p.beds} bedrooms` : 'Brixo rental model estimate (demo) — no direct let comparables' };
}
