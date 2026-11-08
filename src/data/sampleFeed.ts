/**
 * Sample BLM v3 bulk feed from a FICTIONAL agency, as a UK agency CRM would export it.
 * Includes: a listing that duplicates an existing BRIXO listing (to demonstrate merging),
 * a letting, a row with a bad postcode (rejected) and a let-agreed row (skipped).
 */
export const SAMPLE_AGENT = 'Lea Valley Homes (demo agency)';
export const SAMPLE_BLM = `#HEADER#
Version : 3
EOF : '^'
EOR : '~'
Property Count : 6
Generated Date : 08-Nov-2026 09:00
#DEFINITION#
AGENT_REF^ADDRESS_1^ADDRESS_2^TOWN^POSTCODE1^POSTCODE2^FEATURE1^FEATURE2^FEATURE3^SUMMARY^DESCRIPTION^BRANCH_ID^STATUS_ID^BEDROOMS^BATHROOMS^PRICE^PRICE_QUALIFIER^PROP_SUB_ID^TENURE_TYPE_ID^TRANS_TYPE_ID^~
#DATA#
LVH001^Ashcombe Grove^Walthamstow^Walthamstow, London^E17^4QH^Rear garden^Unconverted loft^Chain free^Victorian terrace with loft potential^Three bedroom Victorian terrace in need of modernisation. 92 sq m. EPC rating E. Council tax band D. Freehold.^LVH1^0^3^1^485000^0^1^1^1^~
LVH002^Flat 6, Hoe Court^Hoe Street^Walthamstow, London^E17^7JP^Balcony^Lift^Bike store^Two bedroom flat near Walthamstow Central^Bright second-floor flat, 61 sq m, 125 years remaining on the lease. Service charge £1,400 per year. EPC rating C. Council tax band B.^LVH1^0^2^1^340000^0^8^2^1^~
LVH003^Larkswood Road^^Chingford, London^E4^9DS^Driveway^Large garden^Garage^1930s semi in need of updating^Three bedroom semi-detached house, 101 sq m, needs modernisation throughout. EPC rating D. Council tax band E. Freehold.^LVH1^0^3^1^560000^0^3^1^1^~
LVH004^Flat 2, Grange Mansions^Grange Park Road^Leyton, London^E10^5EP^Furnished^Close to Central line^Pets considered^One bedroom flat to rent^One bedroom flat, 44 sq m, available now. EPC rating C. Council tax band B. Deposit 5 weeks.^LVH1^0^1^1^1600^0^8^2^2^~
LVH005^Station Parade^^Walthamstow, London^XX^ZZZ^^^^Missing postcode test^Bad row^LVH1^0^2^1^300000^0^8^2^1^~
LVH006^Forest Rise^^Walthamstow, London^E17^3PW^^^^Let agreed^Already let^LVH1^3^2^1^1750^0^8^2^2^~
#END#`;

export const SAMPLE_PASTE = `Charming 2 bedroom maisonette for sale
£375,000
Lordship Lane, London SE22 8JL
2 bedrooms · 1 bathroom · 721 sq ft
Leasehold · 89 years remaining · Service charge £950 per year · Council tax band C · EPC rating D
Period features, private garden, needs updating.`;
