import { describe, expect, it } from 'vitest';
import { SAMPLE_AGENT, SAMPLE_BLM } from '../data/sampleFeed';
import { blmFile, letRow, saleRow, type BlmRow } from './blmFixture';
import { isFloorPlanCaption } from './floorplan';
import { decodeFeedBytes, FEED_PLAN_CAPTION, feedLeftOutText, looksLikeBLM, parseBLM } from './listings';

const read = (rows: BlmRow[]) => parseBLM(blmFile(rows), 'Test Agency');
/** The one listing a one-row file gives, or the reason it was rejected. */
const one = (row: BlmRow) => { const r = read([row]); return { listing: r.inputs[0], reason: r.rejected[0]?.reason, report: r }; };

describe('BLM feeds: rents', () => {
  it('turns a weekly, quarterly or annual rent into a monthly figure, to the nearest pound', () => {
    const rent = (price: string, frequency: string) => one(letRow('L1', { PRICE: price, LET_RENT_FREQUENCY: frequency })).listing?.price;
    expect(rent('300', '0')).toBe(1300);      // weekly × 52 ÷ 12
    expect(rent('325', '0')).toBe(1408);      // 1,408.33
    expect(rent('1250', '1')).toBe(1250);     // monthly: as sent
    expect(rent('3600', '2')).toBe(1200);     // quarterly ÷ 3
    expect(rent('3950', '2')).toBe(1317);     // 1,316.67
    expect(rent('15000', '3')).toBe(1250);    // annual ÷ 12
    expect(rent('14999', '3')).toBe(1250);    // 1,249.92
    const built = read([letRow('L1', { PRICE: '300', LET_RENT_FREQUENCY: '0' })]).accepted[0];
    expect(built).toMatchObject({ listing: 'rent', price: 1300 });
  });

  it('rejects a rent it cannot turn into a monthly figure with certainty, and says why', () => {
    expect(one(letRow('L1', { LET_RENT_FREQUENCY: '5' })).reason).toBe('Rent is per person per week (LET_RENT_FREQUENCY 5): Streetkey shows one monthly rent for the whole property');
    expect(one(letRow('L1', { LET_RENT_FREQUENCY: '4' })).reason).toBe('Rent frequency code 4 is not one Streetkey knows (LET_RENT_FREQUENCY)');
    expect(one(letRow('L1', { LET_RENT_FREQUENCY: 'weekly' })).reason).toMatch(/Rent frequency code weekly is not one Streetkey knows/);
    expect(one(letRow('L1', { LET_RENT_FREQUENCY: '' })).reason).toBe('Rent frequency not given (LET_RENT_FREQUENCY): Streetkey cannot tell whether the rent is weekly or monthly');
    // a file with no rent frequency field at all
    expect(parseBLM(blmFile([letRow('L2')], ['LET_RENT_FREQUENCY']), 'Test Agency').rejected[0].reason).toMatch(/^Rent frequency not given/);
    expect(read([letRow('L1', { LET_RENT_FREQUENCY: '5' })]).inputs).toEqual([]);
  });

  it('leaves a sale price alone whatever the rent frequency field holds', () => {
    expect(one(saleRow('S1', { PRICE: '300000', LET_RENT_FREQUENCY: '0' })).listing).toMatchObject({ listing: 'sale', price: 300000 });
  });
});

describe('BLM feeds: price qualifiers', () => {
  it('carries the qualifiers Streetkey can show', () => {
    const qualifier = (code: string) => one(saleRow('S1', { PRICE_QUALIFIER: code })).listing?.priceQualifier;
    expect(qualifier('0')).toBeUndefined();
    expect(qualifier('')).toBeUndefined();
    expect(qualifier('2')).toBe('guide');
    expect(qualifier('3')).toBe('fixed');
    expect(qualifier('4')).toBe('offers over');           // offers in excess of
    expect(qualifier('5')).toBe('offers in region of');
    expect(qualifier('10')).toBe('offers over');
    // a file with no qualifier field at all
    const bare = parseBLM(blmFile([saleRow('S2')], ['PRICE_QUALIFIER']), 'Test Agency');
    expect(bare.fields).toBe(15);
    expect(bare.inputs[0]).toMatchObject({ ref: 'S2', price: 300000 });
    expect(bare.inputs[0]).not.toHaveProperty('priceQualifier');
  });

  it('rejects price on application, and every price it could not show truthfully', () => {
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '1' })).reason).toBe('Price on application: Streetkey shows a price on every listing');
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '1', PRICE: '0' })).reason).toBe('Price on application: Streetkey shows a price on every listing');
    expect(one(letRow('L1', { PRICE_QUALIFIER: '1' })).reason).toBe('Price on application: Streetkey shows a price on every listing');
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '6' })).reason).toMatch(/^Sale by tender \(PRICE_QUALIFIER 6\)/);
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '7' })).reason).toMatch(/^Priced “from” \(PRICE_QUALIFIER 7\)/);
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '9' })).reason).toMatch(/^Shared ownership \(PRICE_QUALIFIER 9\)/);
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '11' })).reason).toMatch(/^Part buy, part rent \(PRICE_QUALIFIER 11\)/);
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '12' })).reason).toMatch(/^Shared equity \(PRICE_QUALIFIER 12\)/);
    expect(one(saleRow('S1', { PRICE_QUALIFIER: '99' })).reason).toBe('Price qualifier code 99 is not one Streetkey knows (PRICE_QUALIFIER)');
    expect(one(saleRow('S1', { PRICE: '' })).reason).toBe('Missing price');
    expect(one(saleRow('S1', { PRICE: 'ask' })).reason).toBe('Missing price');
  });

  it('marks a rent as per calendar month, and refuses a rent that invites offers', () => {
    expect(one(letRow('L1')).listing?.priceQualifier).toBe('pcm');
    expect(one(letRow('L1', { PRICE_QUALIFIER: '3', PRICE: '300', LET_RENT_FREQUENCY: '0' })).listing).toMatchObject({ priceQualifier: 'pcm', price: 1300 });
    expect(one(letRow('L1', { PRICE_QUALIFIER: '10' })).reason).toBe('A rent must be one fixed figure: this letting is marked “offers over” (PRICE_QUALIFIER 10)');
    for (const code of ['2', '4', '5']) expect(one(letRow('L1', { PRICE_QUALIFIER: code })).reason).toMatch(/^A rent must be one fixed figure/);
  });
});

describe('BLM feeds: statuses', () => {
  it('shows under offer, sold subject to contract, reserved and let agreed as under offer, never skipping them', () => {
    const status = (code: string, row = saleRow) => one(row('X1', { STATUS_ID: code })).listing?.status;
    expect(status('0')).toBe('live');
    expect(status('')).toBe('live');
    expect(status('1')).toBe('under offer');            // sold subject to contract
    expect(status('2')).toBe('under offer');            // sold subject to concluded missives (Scotland)
    expect(status('3')).toBe('under offer');            // under offer
    expect(status('4')).toBe('under offer');            // reserved
    expect(status('5', letRow)).toBe('under offer');    // let agreed
    expect(read([saleRow('A', { STATUS_ID: '3' }), letRow('B', { STATUS_ID: '5' })]).rejected).toEqual([]);
  });

  it('rejects a status code it does not know, and a listing the file marks as not published', () => {
    expect(one(saleRow('S1', { STATUS_ID: '9' })).reason).toBe('Status code 9 is not one Streetkey knows (STATUS_ID)');
    expect(one(saleRow('S1', { PUBLISHED_FLAG: '0' })).reason).toBe('Marked as not published in the file (PUBLISHED_FLAG 0)');
    expect(one(saleRow('S1', { PUBLISHED_FLAG: '1' })).listing?.ref).toBe('S1');
  });
});

describe('BLM feeds: nothing is guessed', () => {
  it('rejects a property type Streetkey has no word for, naming the code', () => {
    expect(one(saleRow('S1', { PROP_SUB_ID: '23' })).reason).toBe('Property type code 23 is not one Streetkey shows (PROP_SUB_ID): it shows terraced, semi-detached and detached houses, flats and bungalows');
    expect(one(saleRow('S1', { PROP_SUB_ID: '20' })).reason).toMatch(/^Property type code 20 /);
    expect(one(saleRow('S1', { PROP_SUB_ID: '0' })).reason).toMatch(/^Property type not given \(PROP_SUB_ID is 0\)/);
    expect(one(saleRow('S1', { PROP_SUB_ID: '' })).reason).toMatch(/^Property type not given \(PROP_SUB_ID is empty\)/);
    // the description is never used to make one up, and no type is ever turned into "terraced"
    const cottage = read([saleRow('S1', { PROP_SUB_ID: '23', DESCRIPTION: 'A semi-detached cottage with a detached garage. Freehold.' })]);
    expect(cottage.inputs).toEqual([]);
    expect(cottage.accepted).toEqual([]);
  });

  it('maps the property types it does know', () => {
    const type = (code: string) => one(saleRow('S1', { PROP_SUB_ID: code })).listing?.type;
    expect(['1', '2', '5'].map(type)).toEqual(['terraced', 'terraced', 'terraced']);
    expect(type('3')).toBe('semi-detached');
    expect(type('4')).toBe('detached');
    expect(['7', '8', '9', '10', '11', '28', '29'].map(type)).toEqual(Array(7).fill('flat'));
    expect(['12', '13', '14', '15'].map(type)).toEqual(Array(4).fill('bungalow'));
  });

  it('never invents a tenure for a home for sale', () => {
    expect(one(saleRow('S1', { TENURE_TYPE_ID: '1' })).listing?.tenure).toBe('freehold');
    expect(one(saleRow('S1', { TENURE_TYPE_ID: '2' })).listing?.tenure).toBe('leasehold');
    expect(one(saleRow('S1', { TENURE_TYPE_ID: '5' })).listing?.tenure).toBe('share-of-freehold');
    // no code: the agent's own description decides, and with neither the listing is rejected
    expect(one(saleRow('S1', { TENURE_TYPE_ID: '', DESCRIPTION: 'A house with a garden. Tenure: Leasehold.' })).listing?.tenure).toBe('leasehold');
    expect(one(saleRow('S1', { TENURE_TYPE_ID: '' })).reason).toBe('Tenure not given (TENURE_TYPE_ID): Streetkey shows the tenure of every home for sale');
    expect(one(saleRow('S1', { TENURE_TYPE_ID: '0' })).reason).toMatch(/^Tenure not given/);
    // commonhold is not leasehold
    expect(one(saleRow('S1', { TENURE_TYPE_ID: '4', DESCRIPTION: 'Leasehold flat.' })).reason).toBe('Tenure code 4 is not one Streetkey shows (TENURE_TYPE_ID): it shows freehold, leasehold and share of freehold');
    // a letting is not rejected for having none
    expect(one(letRow('L1', { TENURE_TYPE_ID: '' })).listing?.ref).toBe('L1');
  });

  it('rejects a row that does not say what it is or where it is, and does not invent a bathroom', () => {
    expect(one(saleRow('S1', { TRANS_TYPE_ID: '' })).reason).toBe('The file does not say whether this is a sale or a letting (TRANS_TYPE_ID is empty)');
    expect(one(saleRow('S1', { TRANS_TYPE_ID: '3' })).reason).toBe('The file does not say whether this is a sale or a letting (TRANS_TYPE_ID is 3)');
    expect(one(saleRow('', {})).reason).toBe('Missing agent reference (AGENT_REF)');
    expect(one(saleRow('S1', { TOWN: '' })).reason).toBe('Missing town (TOWN)');
    expect(one(saleRow('S1', { POSTCODE2: '' })).reason).toBe('Missing or invalid postcode');
    expect(one(saleRow('S1', { BATHROOMS: '' })).listing?.baths).toBe(0);
    expect(one(saleRow('S1', { BATHROOMS: '2' })).listing?.baths).toBe(2);
  });
});

describe('BLM feeds: let details', () => {
  it('carries the deposit, available date and furnishing a letting gives', () => {
    expect(one(letRow('L1', { LET_BOND: '1500', LET_DATE_AVAILABLE: '01/12/2026', LET_FURN_ID: '0' })).listing?.letting).toEqual({ deposit: 1500, availableFrom: '2026-12-01', furnished: 'furnished' });
    expect(one(letRow('L1', { LET_DATE_AVAILABLE: '2026-12-01 00:00:00', LET_FURN_ID: '1' })).listing?.letting).toEqual({ availableFrom: '2026-12-01', furnished: 'part-furnished' });
    expect(one(letRow('L1', { LET_DATE_AVAILABLE: '2027-01-15', LET_FURN_ID: '2' })).listing?.letting).toEqual({ availableFrom: '2027-01-15', furnished: 'unfurnished' });
    expect(one(letRow('L1', { LET_DATE_AVAILABLE: '5/1/2027' })).listing?.letting).toEqual({ availableFrom: '2027-01-05' });
  });

  it('leaves out what the file does not give or it cannot read, and says so for a date', () => {
    expect(one(letRow('L1')).listing).not.toHaveProperty('letting');
    // furnishing "not specified" (3) and "furnished or unfurnished" (4) are not one of the three Streetkey shows
    expect(one(letRow('L1', { LET_FURN_ID: '3', LET_BOND: '0' })).listing).not.toHaveProperty('letting');
    expect(one(letRow('L1', { LET_FURN_ID: '4', LET_BOND: 'five weeks' })).listing).not.toHaveProperty('letting');
    const odd = one(letRow('L1', { LET_DATE_AVAILABLE: '31/02/2027', LET_BOND: '900' }));
    expect(odd.listing?.letting).toEqual({ deposit: 900 });
    expect(odd.report.rejected).toEqual([]);
    expect(odd.report.notes).toEqual([{ ref: 'L1', reason: 'Available date “31/02/2027” could not be read (LET_DATE_AVAILABLE): left out' }]);
    expect(one(letRow('L1', { LET_DATE_AVAILABLE: 'now' })).report.notes).toHaveLength(1);
  });

  it('gives a sale no let details', () => {
    expect(one(saleRow('S1', { LET_BOND: '1500', LET_DATE_AVAILABLE: '01/12/2026', LET_FURN_ID: '0' })).listing).not.toHaveProperty('letting');
  });
});

describe('BLM feeds: pictures and documents', () => {
  const cdn = 'https://images.agency-cdn.example.com';
  it('keeps photos, floor plans, energy certificates, brochures and tours apart', () => {
    const r = read([saleRow('S1', {
      MEDIA_IMAGE_00: `${cdn}/front.jpg`, MEDIA_IMAGE_TEXT_00: 'Front', MEDIA_IMAGE_01: `${cdn}/kitchen.jpg`, MEDIA_IMAGE_TEXT_01: 'Kitchen',
      MEDIA_IMAGE_02: `${cdn}/plan-as-image.jpg`, MEDIA_IMAGE_TEXT_02: 'Floorplan',
      MEDIA_IMAGE_03: `${cdn}/epc-early.png`, MEDIA_IMAGE_TEXT_03: 'EPC',
      MEDIA_IMAGE_60: `${cdn}/epc.png`, MEDIA_IMAGE_TEXT_60: 'EPC', MEDIA_IMAGE_61: `${cdn}/epc-2.png`, MEDIA_IMAGE_TEXT_61: '',
      MEDIA_FLOOR_PLAN_00: `${cdn}/plan.png`, MEDIA_FLOOR_PLAN_TEXT_00: 'Ground floor',
      MEDIA_DOCUMENT_00: `${cdn}/brochure.pdf`, MEDIA_DOCUMENT_TEXT_00: 'Brochure', MEDIA_DOCUMENT_50: `${cdn}/epc.pdf`, MEDIA_DOCUMENT_TEXT_50: 'EPC',
      MEDIA_VIRTUAL_TOUR_00: 'https://tours.example.com/s1', MEDIA_VIRTUAL_TOUR_TEXT_00: 'Tour',
    })]);
    const listing = r.inputs[0];
    expect(listing.photos).toEqual([`${cdn}/front.jpg`, `${cdn}/kitchen.jpg`]);
    expect(listing.floorPlans).toEqual([`${cdn}/plan.png`, `${cdn}/plan-as-image.jpg`]);
    expect(r.leftOut).toEqual({ epc: 4, documents: 1, virtualTours: 1, notLinks: 0 });
    // the website's own picture of the listing: the plan is the floor plan, not a photo
    expect(r.accepted[0].photos).toEqual([`${cdn}/front.jpg`, `${cdn}/kitchen.jpg`]);
    expect(r.accepted[0].floorPlan).toEqual({ url: `${cdn}/plan.png`, alt: FEED_PLAN_CAPTION });
    expect(isFloorPlanCaption(FEED_PLAN_CAPTION)).toBe(true);
  });

  it('counts pictures given as file names (media sent in a zip) rather than importing them', () => {
    const r = read([saleRow('S1', { MEDIA_IMAGE_00: 'S1_IMG_00.jpg', MEDIA_IMAGE_01: 'http://images.example.com/plain.jpg', MEDIA_IMAGE_02: `${cdn}/ok.jpg`, MEDIA_FLOOR_PLAN_00: 'S1_FLP_00.gif' })]);
    expect(r.inputs[0].photos).toEqual([`${cdn}/ok.jpg`]);
    expect(r.inputs[0]).not.toHaveProperty('floorPlans');
    expect(r.leftOut.notLinks).toBe(3);
    expect(r.accepted[0].floorPlan).toBeUndefined();
  });

  it('says in words what was left out', () => {
    expect(feedLeftOutText({ epc: 0, documents: 0, virtualTours: 0, notLinks: 0 })).toEqual([]);
    expect(feedLeftOutText({ epc: 4, documents: 1, virtualTours: 2, notLinks: 0 })).toEqual(['Streetkey does not show these yet, so they were left out: 4 energy certificate graphs or documents, 1 brochure or other document, 2 virtual tours.']);
    expect(feedLeftOutText({ epc: 0, documents: 0, virtualTours: 0, notLinks: 1 })).toEqual(['1 picture was left out because it was not given as an https web address. Streetkey does not read file names or http links.']);
    expect(feedLeftOutText({ epc: 0, documents: 0, virtualTours: 0, notLinks: 1200 })).toEqual(['1,200 pictures were left out because they were not given as https web addresses. Streetkey does not read file names or http links.']);
  });
});

describe('BLM feeds: reading the file', () => {
  it('reads Windows-1252 and UTF-8 files', () => {
    expect(decodeFeedBytes(new TextEncoder().encode('£1,400 a year – “bright” flat'))).toBe('£1,400 a year – “bright” flat');
    // Windows-1252: £ is A3, ’ is 92, – is 96, é is E9
    expect(decodeFeedBytes(new Uint8Array([0xa3, 0x31, 0x2c, 0x34, 0x30, 0x30, 0x20, 0x96, 0x20, 0x4f, 0x92, 0x4e, 0x65, 0x69, 0x6c, 0x6c, 0x20, 0x63, 0x61, 0x66, 0xe9]))).toBe('£1,400 – O’Neill café');
    expect(looksLikeBLM(SAMPLE_BLM)).toBe(true);
    expect(looksLikeBLM('AGENT_REF,PRICE\nA1,300000')).toBe(false);
  });

  it('reads the sample feed: one row per outcome', () => {
    const r = parseBLM(SAMPLE_BLM, SAMPLE_AGENT);
    expect(r.inputs.map((i) => i.ref)).toEqual(['LVH001', 'LVH002', 'LVH003', 'LVH004', 'LVH006']);
    expect(r.rejected).toEqual([
      { ref: 'LVH005', reason: 'Missing or invalid postcode' },
      { ref: 'LVH007', reason: 'Price on application: Streetkey shows a price on every listing' },
    ]);
    expect(r.notes).toEqual([]);
    const by = (ref: string) => r.inputs.find((i) => i.ref === ref)!;
    expect(by('LVH003').priceQualifier).toBe('guide');
    expect(by('LVH004')).toMatchObject({ listing: 'rent', price: 1600, priceQualifier: 'pcm', status: 'live', letting: { deposit: 1846, availableFrom: '2026-12-01', furnished: 'furnished' } });
    // let agreed, with a weekly rent of £405
    expect(by('LVH006')).toMatchObject({ listing: 'rent', price: 1755, status: 'under offer', letting: { furnished: 'unfurnished' } });
  });
});
