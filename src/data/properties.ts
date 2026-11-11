/**
 * DEMONSTRATION DATA ONLY.
 * Every listing below is fictional: street names are invented, and prices,
 * rents and history are illustrative values informed by typical market
 * levels for the postcode district. They are NOT live listings and are not
 * sourced from any portal, agent feed or HM Land Registry record.
 */
import type { Condition, Era, PropertyType } from '../engine/refurb';
import type { Nation } from '../engine/tax';

export interface Comparable { address: string; price: number; date: string; beds: number; distanceM: number; kind: 'sold' | 'let'; refurbished: boolean }

export interface Property {
  id: string;
  title: string;
  street: string;           // fictional
  district: string;         // postcode outward code
  postcode: string;         // outward + fictional inward
  town: string;
  nation: Nation;
  lat: number; lng: number;
  listing: 'sale' | 'rent' | 'auction';
  price: number;            // asking (sale) or pcm (rent)
  type: PropertyType;
  tenure: 'freehold' | 'leasehold' | 'share-of-freehold';
  leaseYears?: number;
  beds: number; baths: number; floorArea: number; storeys: number;
  era: Era; condition: Condition;
  epc: { current: string; potential: string; score: number };
  councilTax: string;
  features: string[];
  loftPotential: 'none' | 'possible' | 'strong';
  extensionPotential: 'none' | 'possible' | 'strong';
  estRentPcm: number;       // whole-dwelling estimate
  estGdv: number;           // estimated post-refurb value
  commute: { to: string; minutes: number; mode: string };
  station: { name: string; walkMins: number };
  schools: { name: string; rating: string; distanceKm: number }[];
  risks: { flood: 'very low' | 'low' | 'medium' | 'high'; conservationArea: boolean; article4: boolean; listed: boolean; subsidence: 'low' | 'medium' | 'high'; radon: 'low' | 'moderate' };
  priceHistory: { date: string; price: number; event: string }[];
  areaIndex: number[];      // 24 months of area HPI, rebased 100
  rentDemand: number;       // 0–100 demand index (demo)
  comparables: Comparable[];
  planningNearby: { ref: string; desc: string; decision: 'Approved' | 'Refused' | 'Pending'; distanceM: number }[];
  agent: string;
  daysOnMarket: number;
  photoHue: number;         // used to render placeholder art
  serviceChargeAnnual?: number;
  groundRentAnnual?: number;
  conversionPotential?: 'none' | 'possible' | 'strong';
  use?: 'residential' | 'commercial' | 'mixed';
  documents?: string[];
  /** Where the listing came from and what we're allowed to do with it. Absent = Streetkey demo data. */
  source?: ListingSource;
  /** private = only visible to the user who added it (e.g. a listing analysed from another website). */
  visibility?: 'public' | 'private';
  photos?: string[];          // data URLs (prototype) / CDN URLs (production)
  description?: string;
  status?: 'pending' | 'live' | 'under offer' | 'withdrawn';
  alsoListedBy?: string[];
  createdAt?: string;
}

export type SourceKind = 'demo' | 'owner' | 'landlord' | 'agent-feed' | 'external-link';
export interface ListingSource {
  kind: SourceKind;
  name: string;               // e.g. "Lea Valley Homes (agent feed)", "Private seller"
  url?: string;               // original listing (external links only — we link out, never copy)
  licence: string;            // display/usage terms
  verified: boolean;          // ownership/agent verified
}

const idx = (start: number, drift: number, wobble = 1.2) =>
  Array.from({ length: 24 }, (_, k) => +(start + drift * k + Math.sin(k / 2.3) * wobble).toFixed(1));

export const PROPERTIES: Property[] = [
  {
    id: 'wal-001', title: 'Victorian terrace with loft & side-return potential', street: 'Ashcombe Grove (fictional)', district: 'E17', postcode: 'E17 4QH', town: 'Walthamstow, London', nation: 'england',
    lat: 51.585, lng: -0.018, listing: 'sale', price: 485_000, type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 92, storeys: 2,
    era: 'pre-1919', condition: 'poor', epc: { current: 'E', potential: 'B', score: 48 }, councilTax: 'D',
    features: ['Original features', 'Rear garden 14m', 'Unconverted loft', 'Side return', 'Chain-free probate sale'],
    loftPotential: 'strong', extensionPotential: 'strong', estRentPcm: 2_350, estGdv: 640_000,
    commute: { to: 'Liverpool Street', minutes: 26, mode: 'Overground + walk' }, station: { name: 'Walthamstow Central', walkMins: 9 },
    schools: [{ name: 'Henry Maynard Primary (demo)', rating: 'Good', distanceKm: 0.4 }, { name: 'Walthamstow Academy (demo)', rating: 'Outstanding', distanceKm: 1.1 }],
    risks: { flood: 'very low', conservationArea: false, article4: true, listed: false, subsidence: 'medium', radon: 'low' },
    priceHistory: [{ date: '2003-06', price: 189_000, event: 'Sold' }, { date: '2026-09', price: 499_000, event: 'Listed' }, { date: '2026-10', price: 485_000, event: 'Reduced' }],
    areaIndex: idx(100, 0.25), rentDemand: 86,
    comparables: [
      { address: 'Ashcombe Grove (comp A)', price: 655_000, date: '2026-05', beds: 4, distanceM: 120, kind: 'sold', refurbished: true },
      { address: 'Holmes Rd (comp B)', price: 612_000, date: '2026-02', beds: 3, distanceM: 260, kind: 'sold', refurbished: true },
      { address: 'Pretoria Ave (comp C)', price: 470_000, date: '2025-11', beds: 3, distanceM: 340, kind: 'sold', refurbished: false },
      { address: 'Ashcombe Grove (let)', price: 2_400, date: '2026-08', beds: 3, distanceM: 90, kind: 'let', refurbished: true },
    ],
    planningNearby: [
      { ref: 'DEMO/2026/0412', desc: 'Rear dormer & hip-to-gable loft conversion', decision: 'Approved', distanceM: 60 },
      { ref: 'DEMO/2025/1188', desc: 'Single-storey side-return extension', decision: 'Approved', distanceM: 140 },
      { ref: 'DEMO/2026/0730', desc: 'Change of use C3 → C4 HMO', decision: 'Refused', distanceM: 300 },
    ],
    agent: 'Northbank Estates (example agent)', daysOnMarket: 41, photoHue: 18,
  },
  {
    id: 'cro-002', title: 'Interwar semi in need of modernisation', street: 'Larchfield Road (fictional)', district: 'CR0', postcode: 'CR0 6TN', town: 'Croydon, London', nation: 'england',
    lat: 51.383, lng: -0.072, listing: 'sale', price: 450_000, type: 'semi-detached', tenure: 'freehold', beds: 3, baths: 1, floorArea: 98, storeys: 2,
    era: '1919-1944', condition: 'fair', epc: { current: 'D', potential: 'B', score: 61 }, councilTax: 'D',
    features: ['Driveway', 'Garage', 'South-facing garden', 'Hip roof'], loftPotential: 'possible', extensionPotential: 'strong', estRentPcm: 2_150, estGdv: 560_000,
    commute: { to: 'London Bridge', minutes: 22, mode: 'Rail from East Croydon' }, station: { name: 'East Croydon', walkMins: 18 },
    schools: [{ name: 'Park Hill Juniors (demo)', rating: 'Good', distanceKm: 0.7 }],
    risks: { flood: 'low', conservationArea: false, article4: false, listed: false, subsidence: 'high', radon: 'low' },
    priceHistory: [{ date: '1998-03', price: 112_000, event: 'Sold' }, { date: '2026-08', price: 450_000, event: 'Listed' }],
    areaIndex: idx(100, 0.12), rentDemand: 74,
    comparables: [
      { address: 'Larchfield Rd (comp A)', price: 575_000, date: '2026-04', beds: 4, distanceM: 200, kind: 'sold', refurbished: true },
      { address: 'Birdhurst Ct (comp B)', price: 530_000, date: '2026-01', beds: 3, distanceM: 410, kind: 'sold', refurbished: true },
    ],
    planningNearby: [{ ref: 'DEMO/2026/0098', desc: 'Two-storey side extension', decision: 'Approved', distanceM: 180 }],
    agent: 'Southline Property (example agent)', daysOnMarket: 63, photoHue: 32,
  },
  {
    id: 'mcr-003', title: 'End-terrace, six-bed HMO candidate near Oxford Road corridor', street: 'Cranwell Street (fictional)', district: 'M14', postcode: 'M14 5RB', town: 'Fallowfield, Manchester', nation: 'england',
    lat: 53.443, lng: -2.222, listing: 'sale', price: 265_000, type: 'terraced', tenure: 'freehold', beds: 4, baths: 1, floorArea: 118, storeys: 3,
    era: 'pre-1919', condition: 'poor', epc: { current: 'E', potential: 'C', score: 44 }, councilTax: 'B',
    features: ['Cellar', 'Three storeys', 'Yard', 'Near universities'], loftPotential: 'possible', extensionPotential: 'possible', estRentPcm: 1_450, estGdv: 330_000,
    commute: { to: 'Manchester Piccadilly', minutes: 21, mode: 'Bus' }, station: { name: 'Mauldeth Road', walkMins: 14 },
    schools: [{ name: 'Old Hall Drive Primary (demo)', rating: 'Good', distanceKm: 0.9 }],
    risks: { flood: 'low', conservationArea: false, article4: true, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2011-09', price: 128_000, event: 'Sold' }, { date: '2026-10', price: 265_000, event: 'Listed' }],
    areaIndex: idx(100, 0.38), rentDemand: 91,
    comparables: [
      { address: 'Cranwell St (comp A)', price: 342_000, date: '2026-03', beds: 5, distanceM: 150, kind: 'sold', refurbished: true },
      { address: 'Ladybarn Ln (room let)', price: 720, date: '2026-09', beds: 1, distanceM: 400, kind: 'let', refurbished: true },
    ],
    planningNearby: [{ ref: 'DEMO/2025/2201', desc: 'C3 → C4 HMO (Article 4 area)', decision: 'Refused', distanceM: 220 }, { ref: 'DEMO/2026/0310', desc: 'Sui generis 7-bed HMO', decision: 'Pending', distanceM: 510 }],
    agent: 'Mancunian Homes (example agent)', daysOnMarket: 12, photoHue: 8,
  },
  {
    id: 'lds-004', title: 'Through-terrace back-to-back conversion, Headingley', street: 'Bramwell Mount (fictional)', district: 'LS6', postcode: 'LS6 3JG', town: 'Headingley, Leeds', nation: 'england',
    lat: 53.822, lng: -1.578, listing: 'sale', price: 210_000, type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 84, storeys: 3,
    era: 'pre-1919', condition: 'fair', epc: { current: 'D', potential: 'C', score: 57 }, councilTax: 'B',
    features: ['Attic room', 'Cellar', 'Stone-built'], loftPotential: 'none', extensionPotential: 'none', estRentPcm: 1_250, estGdv: 245_000,
    commute: { to: 'Leeds city centre', minutes: 18, mode: 'Bus' }, station: { name: 'Headingley', walkMins: 11 },
    schools: [{ name: 'Brudenell Primary (demo)', rating: 'Good', distanceKm: 0.5 }],
    risks: { flood: 'very low', conservationArea: true, article4: true, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2015-02', price: 142_000, event: 'Sold' }, { date: '2026-09', price: 210_000, event: 'Listed' }],
    areaIndex: idx(100, 0.22), rentDemand: 82,
    comparables: [{ address: 'Bramwell Mt (comp A)', price: 249_000, date: '2026-06', beds: 3, distanceM: 70, kind: 'sold', refurbished: true }],
    planningNearby: [{ ref: 'DEMO/2026/0555', desc: 'Replacement timber sash windows (conservation area)', decision: 'Approved', distanceM: 40 }],
    agent: 'Aire Valley Lettings (example agent)', daysOnMarket: 29, photoHue: 40,
  },
  {
    id: 'bri-005', title: 'Georgian maisonette, Clifton — share of freehold', street: 'Royal Parade Mews (fictional)', district: 'BS8', postcode: 'BS8 4LD', town: 'Clifton, Bristol', nation: 'england',
    lat: 51.457, lng: -2.62, listing: 'sale', price: 395_000, type: 'flat', tenure: 'share-of-freehold', beds: 2, baths: 1, floorArea: 78, storeys: 2,
    era: 'pre-1919', condition: 'fair', epc: { current: 'D', potential: 'C', score: 58 }, councilTax: 'C',
    features: ['High ceilings', 'Sash windows', 'Communal garden'], loftPotential: 'none', extensionPotential: 'none', estRentPcm: 1_850, estGdv: 455_000,
    commute: { to: 'Bristol Temple Meads', minutes: 24, mode: 'Bus' }, station: { name: 'Clifton Down', walkMins: 12 },
    schools: [{ name: 'Christ Church CofE Primary (demo)', rating: 'Outstanding', distanceKm: 0.6 }],
    risks: { flood: 'very low', conservationArea: true, article4: false, listed: true, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2018-07', price: 335_000, event: 'Sold' }, { date: '2026-10', price: 395_000, event: 'Listed' }],
    areaIndex: idx(100, 0.08), rentDemand: 77,
    comparables: [{ address: 'Royal Parade (comp A)', price: 460_000, date: '2026-01', beds: 2, distanceM: 90, kind: 'sold', refurbished: true }],
    planningNearby: [{ ref: 'DEMO/2026/0127/LBC', desc: 'Listed building consent: internal alterations', decision: 'Approved', distanceM: 30 }],
    agent: 'Avon & Co (example agent)', daysOnMarket: 18, photoHue: 210,
  },
  {
    id: 'bhm-006', title: 'Former corner shop with flat over — commercial to resi', street: 'Stanmore Corner (fictional)', district: 'B29', postcode: 'B29 6EP', town: 'Selly Oak, Birmingham', nation: 'england',
    lat: 52.437, lng: -1.937, listing: 'auction', price: 175_000, type: 'terraced', tenure: 'freehold', beds: 2, baths: 1, floorArea: 135, storeys: 2,
    era: '1919-1944', condition: 'poor', epc: { current: 'F', potential: 'C', score: 32 }, councilTax: 'A (+ business rates)',
    features: ['Class E ground floor', 'Vacant possession', 'Rear yard', 'Auction guide price'], loftPotential: 'none', extensionPotential: 'possible', estRentPcm: 1_700, estGdv: 315_000,
    commute: { to: 'Birmingham New Street', minutes: 15, mode: 'Rail' }, station: { name: 'Selly Oak', walkMins: 6 },
    schools: [{ name: 'Raddlebarn Primary (demo)', rating: 'Requires improvement', distanceKm: 0.8 }],
    risks: { flood: 'medium', conservationArea: false, article4: true, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2001-11', price: 74_000, event: 'Sold' }, { date: '2026-11', price: 175_000, event: 'Auction guide' }],
    areaIndex: idx(100, 0.3), rentDemand: 88,
    comparables: [{ address: 'Bristol Rd (converted pair)', price: 152_000, date: '2026-04', beds: 2, distanceM: 350, kind: 'sold', refurbished: true }],
    planningNearby: [{ ref: 'DEMO/2026/PA/0091', desc: 'Prior approval Class MA: shop → 2 flats', decision: 'Approved', distanceM: 600 }],
    agent: 'Midlands Property Auctions (demo)', daysOnMarket: 6, photoHue: 350,
  },
  {
    id: 'liv-007', title: 'Bay-fronted terrace, ready-to-let after light refurb', street: 'Arnside Terrace (fictional)', district: 'L15', postcode: 'L15 2HE', town: 'Wavertree, Liverpool', nation: 'england',
    lat: 53.399, lng: -2.92, listing: 'sale', price: 165_000, type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 86, storeys: 2,
    era: 'pre-1919', condition: 'fair', epc: { current: 'D', potential: 'C', score: 63 }, councilTax: 'A',
    features: ['Bay window', 'Yard', 'Gas central heating'], loftPotential: 'possible', extensionPotential: 'none', estRentPcm: 1_050, estGdv: 185_000,
    commute: { to: 'Liverpool Lime Street', minutes: 19, mode: 'Bus' }, station: { name: 'Wavertree Technology Park', walkMins: 13 },
    schools: [{ name: 'Lawrence Community Primary (demo)', rating: 'Good', distanceKm: 0.4 }],
    risks: { flood: 'very low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2009-04', price: 98_000, event: 'Sold' }, { date: '2026-07', price: 172_500, event: 'Listed' }, { date: '2026-09', price: 165_000, event: 'Reduced' }],
    areaIndex: idx(100, 0.42), rentDemand: 79,
    comparables: [{ address: 'Arnside Tce (comp)', price: 189_000, date: '2026-05', beds: 3, distanceM: 110, kind: 'sold', refurbished: true }],
    planningNearby: [], agent: 'Mersey Moves (example agent)', daysOnMarket: 88, photoHue: 25,
  },
  {
    id: 'shf-008', title: 'Detached 1970s family home — EPC upgrade opportunity', street: 'Fernhill Rise (fictional)', district: 'S11', postcode: 'S11 9PL', town: 'Ecclesall, Sheffield', nation: 'england',
    lat: 53.355, lng: -1.53, listing: 'sale', price: 520_000, type: 'detached', tenure: 'freehold', beds: 4, baths: 2, floorArea: 145, storeys: 2,
    era: '1945-1979', condition: 'fair', epc: { current: 'D', potential: 'B', score: 59 }, councilTax: 'F',
    features: ['Double garage', 'Large plot', 'Cavity walls (unfilled)'], loftPotential: 'possible', extensionPotential: 'strong', estRentPcm: 2_050, estGdv: 615_000,
    commute: { to: 'Sheffield station', minutes: 22, mode: 'Bus' }, station: { name: 'Dore & Totley', walkMins: 25 },
    schools: [{ name: 'Ecclesall Primary (demo)', rating: 'Outstanding', distanceKm: 0.6 }, { name: 'Silverdale School (demo)', rating: 'Outstanding', distanceKm: 1.4 }],
    risks: { flood: 'very low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'moderate' },
    priceHistory: [{ date: '2007-05', price: 310_000, event: 'Sold' }, { date: '2026-09', price: 520_000, event: 'Listed' }],
    areaIndex: idx(100, 0.18), rentDemand: 61,
    comparables: [{ address: 'Fernhill Rise (comp)', price: 625_000, date: '2026-02', beds: 4, distanceM: 180, kind: 'sold', refurbished: true }],
    planningNearby: [{ ref: 'DEMO/2025/0884', desc: 'Two-storey rear extension', decision: 'Approved', distanceM: 250 }],
    agent: 'Peak Residential (example agent)', daysOnMarket: 34, photoHue: 120,
  },
  {
    id: 'cdf-009', title: 'Victorian terrace, Roath — Welsh LTT applies', street: 'Penylan Close (fictional)', district: 'CF24', postcode: 'CF24 3BW', town: 'Roath, Cardiff', nation: 'wales',
    lat: 51.492, lng: -3.163, listing: 'sale', price: 249_950, type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 90, storeys: 2,
    era: 'pre-1919', condition: 'poor', epc: { current: 'E', potential: 'C', score: 50 }, councilTax: 'C',
    features: ['Rear lane access', 'Original tiles', 'Near Roath Park'], loftPotential: 'strong', extensionPotential: 'possible', estRentPcm: 1_350, estGdv: 315_000,
    commute: { to: 'Cardiff Central', minutes: 17, mode: 'Bus' }, station: { name: 'Cardiff Queen Street', walkMins: 22 },
    schools: [{ name: 'Albany Primary (demo)', rating: 'Good (Estyn)', distanceKm: 0.3 }],
    risks: { flood: 'low', conservationArea: true, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2013-10', price: 158_000, event: 'Sold' }, { date: '2026-10', price: 249_950, event: 'Listed' }],
    areaIndex: idx(100, 0.2), rentDemand: 80,
    comparables: [{ address: 'Penylan Cl (comp)', price: 320_000, date: '2026-03', beds: 3, distanceM: 160, kind: 'sold', refurbished: true }],
    planningNearby: [], agent: 'Taff Homes (example agent)', daysOnMarket: 22, photoHue: 0,
  },
  {
    id: 'gla-010', title: 'Red sandstone tenement flat, Shawlands — LBTT applies', street: 'Kilmory Drive (fictional)', district: 'G41', postcode: 'G41 3SL', town: 'Shawlands, Glasgow', nation: 'scotland',
    lat: 55.829, lng: -4.288, listing: 'sale', price: 215_000, type: 'flat', tenure: 'freehold', beds: 2, baths: 1, floorArea: 82, storeys: 1,
    era: 'pre-1919', condition: 'fair', epc: { current: 'D', potential: 'C', score: 60 }, councilTax: 'C',
    features: ['Bay window', 'Cornicing', 'Shared back court', 'Offers over'], loftPotential: 'none', extensionPotential: 'none', estRentPcm: 1_200, estGdv: 240_000,
    commute: { to: 'Glasgow Central', minutes: 12, mode: 'Rail' }, station: { name: 'Pollokshaws East', walkMins: 6 },
    schools: [{ name: 'Shawlands Primary (demo)', rating: 'Good (Education Scotland)', distanceKm: 0.5 }],
    risks: { flood: 'very low', conservationArea: true, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2016-05', price: 151_000, event: 'Sold' }, { date: '2026-10', price: 215_000, event: 'Offers over' }],
    areaIndex: idx(100, 0.27), rentDemand: 84,
    comparables: [{ address: 'Kilmory Dr (comp)', price: 238_000, date: '2026-06', beds: 2, distanceM: 60, kind: 'sold', refurbished: true }],
    planningNearby: [], agent: 'Clydeside Estates (example agent)', daysOnMarket: 9, photoHue: 15,
  },
  {
    id: 'not-011', title: 'To let: refurbished 2-bed flat, Nottingham city centre', street: 'Lace Market Yard (fictional)', district: 'NG1', postcode: 'NG1 1PB', town: 'Nottingham', nation: 'england',
    lat: 52.952, lng: -1.143, listing: 'rent', price: 1_250, type: 'flat', tenure: 'leasehold', leaseYears: 118, beds: 2, baths: 2, floorArea: 68, storeys: 1,
    era: '2000+', condition: 'good', epc: { current: 'B', potential: 'B', score: 82 }, councilTax: 'B',
    features: ['Periodic assured tenancy', 'Concierge', 'Allocated parking'], loftPotential: 'none', extensionPotential: 'none', estRentPcm: 1_250, estGdv: 205_000,
    commute: { to: 'Nottingham station', minutes: 9, mode: 'Walk' }, station: { name: 'Nottingham', walkMins: 9 },
    schools: [], risks: { flood: 'low', conservationArea: true, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2026-10', price: 1_250, event: 'Listed to let' }], areaIndex: idx(100, 0.15), rentDemand: 72,
    comparables: [{ address: 'Lace Market (let comp)', price: 1_275, date: '2026-08', beds: 2, distanceM: 120, kind: 'let', refurbished: true }],
    planningNearby: [], agent: 'Trent Lettings (example agent)', daysOnMarket: 4, photoHue: 260,
  },
  {
    id: 'bri-012', title: 'To let: 3-bed family house with garden, Bishopston', street: 'Ashgrove Walk (fictional)', district: 'BS7', postcode: 'BS7 8QR', town: 'Bishopston, Bristol', nation: 'england',
    lat: 51.48, lng: -2.59, listing: 'rent', price: 2_150, type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 95, storeys: 2,
    era: 'pre-1919', condition: 'good', epc: { current: 'C', potential: 'B', score: 70 }, councilTax: 'C',
    features: ['Periodic assured tenancy', 'Pets considered', 'Garden'], loftPotential: 'possible', extensionPotential: 'none', estRentPcm: 2_150, estGdv: 520_000,
    commute: { to: 'Bristol Temple Meads', minutes: 20, mode: 'Bus' }, station: { name: 'Montpelier', walkMins: 15 },
    schools: [{ name: 'Bishop Road Primary (demo)', rating: 'Outstanding', distanceKm: 0.4 }],
    risks: { flood: 'very low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2026-10', price: 2_150, event: 'Listed to let' }], areaIndex: idx(100, 0.11), rentDemand: 89,
    comparables: [], planningNearby: [], agent: 'Avon & Co (example agent)', daysOnMarket: 3, photoHue: 150,
  },
];

PROPERTIES.push(
  {
    id: 'cro-013', title: 'Edwardian double-fronted house — potential flat conversion', street: 'Wellesley Gardens (fictional)', district: 'CR0', postcode: 'CR0 2RN', town: 'Croydon, London', nation: 'england',
    lat: 51.379, lng: -0.094, listing: 'sale', price: 825_000, type: 'detached', tenure: 'freehold', beds: 6, baths: 2, floorArea: 238, storeys: 3,
    era: 'pre-1919', condition: 'poor', epc: { current: 'E', potential: 'C', score: 46 }, councilTax: 'G',
    features: ['Double-fronted', 'Large plot', 'Off-street parking', 'Close to East Croydon'], loftPotential: 'possible', extensionPotential: 'possible', estRentPcm: 3_900, estGdv: 1_020_000,
    commute: { to: 'London Bridge', minutes: 16, mode: 'Rail from East Croydon' }, station: { name: 'East Croydon', walkMins: 9 },
    schools: [{ name: 'Chestnut Park Primary (demo)', rating: 'Good', distanceKm: 0.6 }],
    risks: { flood: 'low', conservationArea: false, article4: false, listed: false, subsidence: 'medium', radon: 'low' },
    priceHistory: [{ date: '1994-08', price: 168_000, event: 'Sold' }, { date: '2026-08', price: 875_000, event: 'Listed' }, { date: '2026-10', price: 825_000, event: 'Reduced' }],
    areaIndex: idx(100, 0.1), rentDemand: 83,
    comparables: [
      { address: 'Wellesley Gdns (flat conversion, 2-bed unit)', price: 335_000, date: '2026-04', beds: 2, distanceM: 140, kind: 'sold', refurbished: true },
      { address: 'Park Lane Rd (1-bed unit)', price: 245_000, date: '2026-06', beds: 1, distanceM: 380, kind: 'sold', refurbished: true },
      { address: 'Chepstow Rd (unconverted)', price: 860_000, date: '2025-12', beds: 6, distanceM: 420, kind: 'sold', refurbished: false },
    ],
    planningNearby: [
      { ref: 'DEMO/2025/3301', desc: 'Conversion of single dwelling into 4 self-contained flats', decision: 'Approved', distanceM: 160 },
      { ref: 'DEMO/2026/0412', desc: 'Conversion into 5 flats with rear dormer', decision: 'Refused', distanceM: 310 },
    ],
    agent: 'Southline Property (example agent)', daysOnMarket: 74, photoHue: 28, conversionPotential: 'strong', use: 'residential',
    documents: ['EPC', 'Floor plan', 'Title register (requested)'],
  },
  {
    id: 'ley-014', title: 'Two-bed flat, low service charge, dated kitchen', street: 'Marsh Lane Court (fictional)', district: 'E10', postcode: 'E10 7BL', town: 'Leyton, London', nation: 'england',
    lat: 51.566, lng: -0.012, listing: 'sale', price: 335_000, type: 'flat', tenure: 'leasehold', leaseYears: 142, beds: 2, baths: 1, floorArea: 64, storeys: 1,
    era: '1980-1999', condition: 'fair', epc: { current: 'C', potential: 'B', score: 71 }, councilTax: 'C',
    features: ['Share of freehold available', 'Balcony', 'Service charge £1,150 p.a.', 'Allocated parking'], loftPotential: 'none', extensionPotential: 'none', estRentPcm: 1_900, estGdv: 375_000,
    commute: { to: 'Liverpool Street', minutes: 22, mode: 'Central line from Leyton' }, station: { name: 'Leyton', walkMins: 8 },
    schools: [{ name: 'Riverley Primary (demo)', rating: 'Good', distanceKm: 0.5 }],
    risks: { flood: 'low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2012-03', price: 205_000, event: 'Sold' }, { date: '2026-10', price: 335_000, event: 'Listed' }],
    areaIndex: idx(100, 0.16), rentDemand: 90,
    comparables: [{ address: 'Marsh Lane Ct (comp, refurbished)', price: 372_000, date: '2026-05', beds: 2, distanceM: 40, kind: 'sold', refurbished: true }, { address: 'Marsh Lane Ct (let)', price: 1_925, date: '2026-09', beds: 2, distanceM: 40, kind: 'let', refurbished: true }],
    planningNearby: [], agent: 'Northbank Estates (example agent)', daysOnMarket: 15, photoHue: 200, serviceChargeAnnual: 1_150, groundRentAnnual: 0, use: 'residential',
    documents: ['EPC', 'Floor plan', 'Lease', 'Service charge accounts 2025', 'LPE1 (requested)'],
  },
  {
    id: 'wat-015', title: 'Vacant 1980s office building — office-to-residential (Class MA) candidate', street: 'Clarendon Yard (fictional)', district: 'WD17', postcode: 'WD17 1HP', town: 'Watford, Hertfordshire', nation: 'england',
    lat: 51.659, lng: -0.401, listing: 'sale', price: 1_450_000, type: 'commercial', tenure: 'freehold', beds: 0, baths: 6, floorArea: 2_150, storeys: 4,
    era: '1980-1999', condition: 'fair', epc: { current: 'D', potential: 'B', score: 64 }, councilTax: 'Business rates',
    features: ['Class E office', 'Vacant possession', '22 parking spaces', '5 min to Watford Junction'], loftPotential: 'none', extensionPotential: 'possible', estRentPcm: 0, estGdv: 1_600_000,
    commute: { to: 'London Euston', minutes: 16, mode: 'Rail from Watford Junction' }, station: { name: 'Watford Junction', walkMins: 5 },
    schools: [], risks: { flood: 'low', conservationArea: false, article4: true, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: '2008-02', price: 1_900_000, event: 'Sold' }, { date: '2026-09', price: 1_450_000, event: 'Listed' }],
    areaIndex: idx(100, 0.12), rentDemand: 78,
    comparables: [{ address: 'Station Rd conversion (1-bed unit)', price: 255_000, date: '2026-03', beds: 1, distanceM: 400, kind: 'sold', refurbished: true }, { address: 'Station Rd conversion (2-bed unit)', price: 335_000, date: '2026-05', beds: 2, distanceM: 400, kind: 'sold', refurbished: true }],
    planningNearby: [{ ref: 'DEMO/2025/PA/0218', desc: 'Prior approval Class MA: office to 30 flats (similar 1980s block)', decision: 'Approved', distanceM: 450 }, { ref: 'DEMO/2026/A4/001', desc: 'Article 4 direction removing Class MA (town centre core)', decision: 'Pending', distanceM: 0 }],
    agent: 'Herts Commercial (example agent)', daysOnMarket: 58, photoHue: 215, conversionPotential: 'strong', use: 'commercial',
    documents: ['EPC (non-domestic)', 'Floor plans', 'Measured survey', 'Asbestos register'],
  },
);

/**
 * Listings merged into another listing for the same home (see dedupe in engine/listings): left out of
 * PROPERTIES, so no list or search shows the home twice, but still found by their own reference
 * (a link to an owner's post that duplicates an agent's listing still opens and prefills from that post).
 */
const mergedAway = new Map<string, Property>();
export const getProperty = (id: string) => PROPERTIES.find((p) => p.id === id) ?? mergedAway.get(id);

/** Base (demo) set, captured before any dynamic listings are registered. */
const BASE_COUNT = PROPERTIES.length;
/**
 * Register user-posted, feed-ingested and privately tracked listings into the
 * shared registry so every engine and screen can use them. Replaces any
 * previously registered dynamic listings. `hidden`: listings merged into another
 * one for the same home, findable only by getProperty(id). Optional.
 */
export function setDynamicListings(list: Property[], hidden: Property[] = []) {
  PROPERTIES.splice(BASE_COUNT, PROPERTIES.length - BASE_COUNT, ...list.filter((p) => !PROPERTIES.slice(0, BASE_COUNT).some((b) => b.id === p.id)));
  mergedAway.clear();
  const shown = new Set(PROPERTIES.map((p) => p.id));
  for (const p of hidden) if (!shown.has(p.id)) mergedAway.set(p.id, p);
}
export const baseListings = () => PROPERTIES.slice(0, BASE_COUNT);
export const publicListings = () => PROPERTIES.filter((p) => p.visibility !== 'private' && p.status !== 'withdrawn');

/** Demo photo set for a listing. Photos are illustrations; ids drive engagement analytics. */
export function photosFor(p: Property) {
  const base = p.type === 'commercial'
    ? ['Front elevation', 'Open-plan office floor', 'Reception', 'Car park', 'Floor plan view']
    : ['Front elevation', 'Living room', 'Kitchen', p.type === 'flat' ? 'Balcony / view' : 'Rear garden', 'Main bedroom', 'Bathroom'];
  return base.map((label, i) => ({ id: `${p.id}-ph${i + 1}`, label, index: i }));
}
