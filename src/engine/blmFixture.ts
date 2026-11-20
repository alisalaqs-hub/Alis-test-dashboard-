/**
 * For tests only (the website never loads this): builds a BLM v3 file from rows of field values, so a test
 * states just the fields it is about. Every row starts as a two-bedroom leasehold flat for sale in E17.
 */
export type BlmRow = Record<string, string>;

const BASE: BlmRow = {
  AGENT_REF: 'R1', ADDRESS_1: '1 Feed Street', ADDRESS_2: '', TOWN: 'London', POSTCODE1: 'E17', POSTCODE2: '4QH',
  SUMMARY: 'Two-bedroom flat', DESCRIPTION: 'A bright flat with a balcony. EPC rating C. Council tax band B.',
  BEDROOMS: '2', BATHROOMS: '1', PRICE: '300000', PRICE_QUALIFIER: '0', PROP_SUB_ID: '8', TENURE_TYPE_ID: '2', TRANS_TYPE_ID: '1', STATUS_ID: '0',
};

/** A BLM v3 file with these rows. The field list is every field any row names, plus the usual ones, less any in `without`. */
export function blmFile(rows: BlmRow[], without: string[] = []): string {
  const fields = [...new Set([...Object.keys(BASE), ...rows.flatMap((r) => Object.keys(r))])].filter((f) => !without.includes(f));
  const data = rows.map((r) => fields.map((f) => r[f] ?? BASE[f] ?? '').join('^') + '^');
  return `#HEADER#\nVersion : 3\nEOF : '^'\nEOR : '~'\n#DEFINITION#\n${fields.join('^')}^~\n#DATA#\n${data.join('~\n')}~\n#END#`;
}
/** A home for sale with this reference. */
export const saleRow = (ref: string, fields: BlmRow = {}): BlmRow => ({ AGENT_REF: ref, ...fields });
/** A home to let with this reference: £1,200 a month unless the fields say otherwise. */
export const letRow = (ref: string, fields: BlmRow = {}): BlmRow => ({ AGENT_REF: ref, TRANS_TYPE_ID: '2', PRICE: '1200', LET_RENT_FREQUENCY: '1', ...fields });
