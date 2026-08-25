const PERSONA_LABELS = {
  cardAndBank: 'Trevor - pays card in full',
  bankOnly: 'Marsha - everyday banking only',
  cardOnly: 'Damion - carries a card balance',
};

/* ===========================================================================
 *  THE SHOPS PEOPLE NAME  (card side)
 *  ---------------------------------------------------------------------------
 *  These are invented shopping patterns, not anyone's real spending. The names
 *  are the businesses a Jamaican cardholder would recognise, drawn from the
 *  project's own researched directory of Jamaican merchants and from general
 *  national knowledge. The one hard line: nothing here is a merchant, amount,
 *  or pattern taken from the real statements shared for app development. Beyond
 *  that line the build-out is free, national chains and independents alike, so
 *  long as none of it traces back to that real data.
 *
 *  The spread matches how a card is actually used here: the big grocery
 *  chains, the fast-food and patty places, the fuel brands and the coaches
 *  and highways, the airlines and the Kingston hotels, the phone and internet
 *  providers, the pharmacies and private hospitals and labs, the overseas
 *  sites people order from, the furniture, hardware, appliance and book
 *  stores, the cinemas and gyms and attractions, the package-forwarding
 *  couriers that bring the online orders in, the everyday home services, the
 *  car dealers and parts shops, and the government offices people pay. This is
 *  a curated slice of the wider database rather than the whole of it, so the
 *  file stays readable and the categoriser is tested against a realistic mix
 *  instead of a copy of its own dictionary. A separate drift-check script
 *  (merchant-drift-check.mjs) reports national chains added to the database
 *  later that could be folded in, so the slice never quietly goes stale.
 *  Groceries carry the heaviest weight throughout, because food is roughly
 *  thirty-seven per cent of the Jamaican shopping basket, the highest share in
 *  the Caribbean.
 *  ======================================================================== */
const CARD_MERCHANTS = {
  Groceries: [
    'HI-LO FOOD STORES',
    'MEGAMART',
    'PRICESMART',
    'LOSHUSAN SUPERMARKET',
    'SOVEREIGN SUPERMARKET',
    'PROGRESSIVE FOODS',
    'SHOPPERS FAIR',
    'SAMPARS',
    'GENERAL FOOD SUPERMARKET',
    'JOHN R WONG',
    "LEE'S FOOD FAIR",
    'CPJ MARKET',
    'FRESH MARKET',
    'RAINFOREST SEAFOODS',
  ],
  'Dining & Takeout': [
    'ISLAND GRILL',
    'JUICI PATTIES',
    'TASTEE',
    'KFC',
    "MOTHER'S",
    "WENDY'S",
    'BURGER KING',
    'POPEYES',
    'PIZZA HUT',
    "DOMINO'S PIZZA",
    'SCOTCHIES',
    'TACBAR',
    'CAFE BLUE',
    'DEVON HOUSE',
    'STARBUCKS',
    'KRISPY KREME',
    "CHURCH'S CHICKEN",
    'LITTLE CAESARS',
    "MCDONALD'S",
    'UBER EATS',
    'TRACKS & RECORDS',
    'REDBONES',
    'PUSHCART',
  ],
  'Fuel & Transport': [
    'RUBIS',
    'TOTAL',
    'FESCO',
    'TEXACO',
    'PETCOM',
    'COOL PETROLEUM',
    'EPPING GAS',
    'KNUTSFORD EXPRESS',
    'JUTA',
    'TRANSJAMAICAN HIGHWAY',
    'JAMAICA NORTH SOUTH HIGHWAY',
    'UBER',
    'INDRIVE',
  ],
  'Hotels & Travel': [
    'AMERICAN AIRLINES',
    'CARIBBEAN AIRLINES',
    'JETBLUE',
    'DELTA AIR LINES',
    'COPA AIRLINES',
    'SPIRIT AIRLINES',
    'SANDALS',
    'THE COURTLEIGH',
    'SPANISH COURT HOTEL',
    'JAMAICA PEGASUS',
    'AC HOTEL KINGSTON',
    'ROK HOTEL',
    'S HOTEL',
    'TERRA NOVA',
    'KNUTSFORD COURT HOTEL',
    'MARRIOTT',
    'AIRBNB',
    'BOOKING.COM',
    'EXPEDIA',
  ],
  Telecom: ['DIGICEL', 'FLOW', 'DEKAL WIRELESS', 'XTRINET', 'STARS CABLE', 'PINGLINKS'],
  'Pharmacy & Health': [
    'FONTANA PHARMACY',
    'HEALTH PLUS PHARMACY',
    'MANOR PARK PHARMACY',
    'ARDENNE PHARMACY',
    'LIGUANEA LANE PHARMACY',
    "LUCKY'S PHARMACY",
    'PHARMACY PLUS',
    'DRUGS FOR LESS',
    'MEDLABS',
    'SUPERIOR OPTICAL',
    "SANGSTER'S OPTICIANS",
    'ANDREWS MEMORIAL HOSPITAL',
    'MEDICAL ASSOCIATES',
    'HOSPITEN',
    'NUTTALL HOSPITAL',
  ],
  'Online Shopping': [
    'AMAZON',
    'SHEIN',
    'ALIEXPRESS',
    'TEMU',
    'EBAY',
    'NIKE',
    'ADIDAS',
    'ASOS',
    'FASHION NOVA',
    'PRETTYLITTLETHING',
    'ETSY',
    'IHERB',
    'WAYFAIR',
    'PAYPAL',
    'GYMSHARK',
    'JOMASHOP',
  ],
  'Retail & Department': [
    'COURTS',
    'SINGER',
    'FONTANA',
    'ATL APPLIANCE TRADERS',
    "AMMAR'S",
    "AZAN'S",
    'WOOLWORTH',
    'KINGSTON BOOKSHOP',
    "SANGSTER'S BOOK STORES",
    'PAYLESS',
    'ROYALE JEWELLERS',
    'TANK-WELD',
    'ABC HARDWARE',
    'RAPID & SHEFFIELD',
    "BRYDEN'S FURNITURE",
    'TROPICAL FURNITURE',
    'MAXIE',
    "LEE'S FIFTH AVENUE",
    'BEST BUY',
    "MACY'S",
    'ROSS',
    'TJ MAXX',
    'H&M',
    'FOOT LOCKER',
    'HOME DEPOT',
  ],
  'Entertainment & Recreation': [
    'PALACE AMUSEMENT',
    'CARIBTIX',
    'DEVON HOUSE I SCREAM',
    'HOPE ZOO',
    'KOOL RUNNINGS',
    'CHUKKA CARIBBEAN',
    'DOLPHIN COVE',
    "DUNN'S RIVER FALLS",
    'SPARTAN HEALTH CLUB',
    'PLANET FITNESS',
    'EVENTBRITE',
    'UTICKET',
    'RAINFOREST ADVENTURES',
  ],
  'Courier & Shipping': [
    'MAILPAC',
    'AEROPOST',
    'SKYBOX',
    'SHIPME',
    'TARA COURIERS',
    'AIRPAK EXPRESS',
    'CGL COURIERS',
    'JAMAICA FREIGHT & SHIPPING',
    'ZIPMAIL',
    'FEDEX',
    'DHL',
    'UPS',
  ],
  'Home & Services': [
    'SUPERCLEANERS',
    'TAI FLORA',
    'PHOTO EXPRESS',
    'MIKES WATER',
    'WELL FILTERED',
    'UP TOWN BARBER',
    'GUHDEH ERRANDS',
    'FROM YOU FLOWERS',
  ],
  'Auto & Vehicle': [
    'ATL AUTOMOTIVE',
    'TOYOTA JAMAICA',
    'MAGNA MOTORS',
    'FIDELITY MOTORS',
    'SILVER STAR MOTORS',
    "STEWART'S AUTO",
    'HONDA PLUS',
    'SUPERIOR PARTS',
    "BERT'S AUTO PARTS",
  ],
  'Government & Tax': [
    'TAX ADMINISTRATION JAMAICA',
    'TAJ ONLINE',
    'DTOP ISLAND TRAFFIC',
    'JAMAICA CUSTOMS',
    'GOJ ESERVICES',
    'NATIONAL LAND AGENCY',
    'REGISTRAR GENERAL',
  ],
};

/* ===========================================================================
 *  WHAT EACH KIND OF SHOP COSTS, IN JAMAICAN DOLLARS
 *  ---------------------------------------------------------------------------
 *  A low-to-high band for each kind of shop. A supermarket run swings widely,
 *  a patty or a juice is small, a phone top-up sits in the few-hundred-to-few-
 *  thousand range, furniture or an appliance can be large, a flight larger
 *  still, a car service or set of parts larger again, and a tax or licence
 *  payment anywhere from a small fee to a sizeable property-tax bill. These are
 *  invented everyday amounts; the genuinely large, fixed commitments (a
 *  mortgage, a car note, rent, school fees, a card's annual fee) and the
 *  deliberate one-off big-ticket buys belong to a person's story below and are
 *  set as fixed anchors rather than a dice roll. Each band is
 *  [min, max, mode]: amounts are drawn on a right-skewed triangular
 *  distribution around the mode, so most land near the typical figure with a
 *  thinning tail toward the maximum, rather than every value being equally
 *  likely. A band given as [min, max] falls back to a mode at 35% of the range.
 *  ======================================================================== */
const CARD_AMOUNTS = {
  Groceries: [2000, 24000, 7000],
  'Dining & Takeout': [700, 7000, 1800],
  'Fuel & Transport': [3500, 9000, 6000],
  'Hotels & Travel': [12000, 140000, 30000],
  Telecom: [600, 4000, 1500],
  'Pharmacy & Health': [900, 12000, 2500],
  'Online Shopping': [2500, 30000, 7000],
  'Retail & Department': [4000, 60000, 12000],
  'Entertainment & Recreation': [1500, 25000, 5000],
  'Courier & Shipping': [1500, 18000, 4500],
  'Home & Services': [1500, 20000, 5000],
  'Auto & Vehicle': [5000, 80000, 16000],
  'Government & Tax': [2000, 50000, 6000],
};

/* ===========================================================================
 *  THE SHOPS ON A BANK CARD  (accounts side)
 *  ---------------------------------------------------------------------------
 *  Where a debit card is swiped shows up on a bank statement as a point-of-sale
 *  line. This replaces the old four-name stand-in with a proper spread of the
 *  everyday national places a person actually taps a card: supermarkets, the
 *  pharmacy, the hardware store, the fuel station, the appliance and furniture
 *  shops. Same discipline as the card list, nothing here comes from the real
 *  statements.
 *  ======================================================================== */
const BANK_POS_MERCHANTS = [
  'HI-LO FOOD STORES',
  'MEGAMART',
  'PRICESMART',
  'LOSHUSAN SUPERMARKET',
  'SHOPPERS FAIR',
  'SOVEREIGN SUPERMARKET',
  'PROGRESSIVE FOODS',
  'GENERAL FOOD SUPERMARKET',
  'CPJ MARKET',
  'FONTANA PHARMACY',
  'HEALTH PLUS PHARMACY',
  'DRUGS FOR LESS',
  'MANOR PARK PHARMACY',
  'RUBIS',
  'TOTAL',
  'FESCO',
  'TEXACO',
  'PETCOM',
  'ISLAND GRILL',
  'JUICI PATTIES',
  'TASTEE',
  'KFC',
  'CAFE BLUE',
  'DEVON HOUSE',
  'DIGICEL',
  'FLOW',
  'COURTS',
  'SINGER',
  'ATL APPLIANCE TRADERS',
  'TANK-WELD',
  'ABC HARDWARE',
  'RAPID & SHEFFIELD',
  'KINGSTON BOOKSHOP',
  'PAYLESS',
  "BRYDEN'S FURNITURE",
  'WOOLWORTH',
  'MAXIE',
  'PALACE AMUSEMENT',
  'DEVON HOUSE I SCREAM',
  'SUPERCLEANERS',
  'UP TOWN BARBER',
];

/* ===========================================================================
 *  THE MONTHLY DIGITAL SUBSCRIPTIONS
 *  ---------------------------------------------------------------------------
 *  A pool of the streaming, music, storage and utility services people put on
 *  a card, at invented amounts close to what they cost in Jamaican dollars.
 *  Each person below carries their own handful rather than the same set, the
 *  way real subscriptions differ from one person to the next, and the ones
 *  they carry recur every month unchanged, which is exactly what the "regular
 *  payments" feature is meant to find.
 *  ======================================================================== */
const SUBSCRIPTION_POOL = [
  { desc: 'NETFLIX.COM', amount: 2500 },
  { desc: 'SPOTIFY', amount: 1200 },
  { desc: 'APPLE.COM/BILL', amount: 1300 },
  { desc: 'DISNEY PLUS', amount: 1800 },
  { desc: 'YOUTUBE PREMIUM', amount: 2200 },
  { desc: 'AMAZON PRIME', amount: 1900 },
  { desc: 'MICROSOFT 365', amount: 1500 },
  { desc: 'HBO MAX', amount: 1600 },
  { desc: 'SPORTSMAX', amount: 1500 },
  { desc: 'AUDIBLE', amount: 2400 },
  { desc: 'GOOGLE STORAGE', amount: 400 },
  { desc: 'PARAMOUNT PLUS', amount: 1400 },
  { desc: 'ICLOUD STORAGE', amount: 500 },
  { desc: 'LINKEDIN PREMIUM', amount: 4800 },
  { desc: 'CANVA PRO', amount: 1900 },
  { desc: 'DAZN', amount: 2600 },
  { desc: 'CRUNCHYROLL', amount: 1500 },
  { desc: 'DROPBOX', amount: 1800 },
];

/* ===========================================================================
 *  THE BILLS THAT LEAVE THE BANK ACCOUNT ON THEIR OWN EACH MONTH
 *  ---------------------------------------------------------------------------
 *  A fuller household than the old three lines: light and water, home internet
 *  and a postpaid phone plan, life cover, a gym membership, and alarm
 *  monitoring, each pulled by standing order at invented but ordinary amounts.
 *  These are the household running costs the accounts side shows as bills and
 *  standing payments, and being steady month to month is exactly what makes
 *  them the standing debits the detector is meant to find.
 *  ======================================================================== */
const BANK_BILLS = [
  { desc: 'JPS ELECTRICITY', type: 'PRE-AUTHORIZED DEBIT', amount: 15000 },
  { desc: 'NWC WATER', type: 'PRE-AUTHORIZED DEBIT', amount: 4500 },
  { desc: 'FLOW INTERNET', type: 'ELECTRONIC DATA DEBIT', amount: 8900 },
  { desc: 'DIGICEL POSTPAID', type: 'ELECTRONIC DATA DEBIT', amount: 6500 },
  { desc: 'FLOW CABLE TV', type: 'ELECTRONIC DATA DEBIT', amount: 7200 },
  { desc: 'LIFE INSURANCE PREMIUM', type: 'STANDING ORDER', amount: 9500 },
  { desc: 'HEALTH INSURANCE PREMIUM', type: 'STANDING ORDER', amount: 8200 },
  { desc: 'SPARTAN HEALTH CLUB', type: 'RECURRING POS', amount: 7000 },
  { desc: 'ALARM MONITORING', type: 'RECURRING POS', amount: 4200 },
];

/* ===========================================================================
 *  THE PEOPLE
 *  ---------------------------------------------------------------------------
 *  Three invented Jamaicans, one for each shape of imported history: one who
 *  brings in both a credit card and a bank account, one who brings in only a
 *  bank account, and one who brings in only a credit card. The names are
 *  placeholders; final naming is handled separately. Nothing here is drawn from
 *  the real statements shared for app development. Every figure that carries
 *  weight is grounded in general Jamaican research: what people earn, how they
 *  are paid, how homes and cars are financed, how rent and school fees fall,
 *  how cards and funds are used, and the pressures that shape all of it. The
 *  story comes first and the settings follow from it, so anyone reading meets a
 *  person before a config, and the last line of each note says what the app
 *  should do with them, so the person and the job stay in step.
 *  ======================================================================== */
const PERSONAS = {
  /* -------------------------------------------------------------------------
   *  CARD + BANK  ·  TREVOR ASHFORD  ·  44  ·  Kingston   (placeholder name)
   *  ---------------------------------------------------------------------
   *  Trevor runs the finance function at a mid-sized firm and earns a little
   *  above $520,000 a month, past the $500,000 line where the higher 30%
   *  income-tax rate begins. His money runs like clockwork. The salary lands
   *  once a month; a newer car he financed at one of the near-zero dealer-
   *  promotion rates leaves a fixed note of $70,000 every month; and the day
   *  after payday a standing order sweeps $40,000 into a unit-trust fund, the
   *  kind that takes $10,000 top-ups and pays out tax-free once it has been
   *  held five years. Light, water, internet, phone, life cover, the gym and
   *  the alarm all leave on their own.
   *
   *  He keeps one everyday account, which is still how most people bank even
   *  when they could run several, and puts almost everything on a travel-
   *  rewards card to earn the points: the supermarket run, dining, fuel, the
   *  odd flight and hotel, the gym, the packages that come in by forwarding
   *  courier, and the property-tax bill when it falls. The card carries a real
   *  annual fee of $8,884.12 that posts once a year, and one month he buys a
   *  major appliance outright, a clear big-ticket outlier. A returned purchase
   *  shows up now and then as a credit. He clears the full balance every month
   *  without fail, so he never pays a cent of interest.
   *
   *  What the app should do with him: read the card as paid-in-full and stay
   *  calm, with no payoff maths; let the monthly move into the fund read as
   *  saving, not spending; catch the appliance as the standout charge it is;
   *  and treat the returned-purchase credits as refunds rather than income.
   * --------------------------------------------------------------------- */
  cardAndBank: {
    firstName: 'Trevor',
    seed: 'cardandbank',
    months: 8,
    hasCard: true,
    hasBank: true,
    monthlyIncome: 520000,
    incomeType: 'SALARY',
    incomeDesc: 'SALARY PAYROLL',
    cardTxnsPerMonth: 30,
    cardBehaviour: 'transactor',
    creditLimit: 900000,
    cardAccount: '4021',
    cardAnnualFee: {
      desc: 'CREDIT CARD ANNUAL FEE',
      amount: 8884.12,
      monthIndex: 2,
    },
    subscriptionCount: 4,
    refundChance: 0.35,
    cardOneOffs: [{ monthIndex: 4, desc: 'ATL APPLIANCE TRADERS', amount: 214900, day: 12 }],
    spendWeights: {
      Groceries: 4,
      'Dining & Takeout': 2,
      'Fuel & Transport': 2,
      'Hotels & Travel': 1,
      'Entertainment & Recreation': 1,
      'Courier & Shipping': 1,
      Telecom: 1,
      'Pharmacy & Health': 1,
      'Online Shopping': 1,
      'Retail & Department': 1,
      'Government & Tax': 1,
    },
    accounts: [
      {
        number: '1234',
        currency: 'JMD',
        opening: 640000,
        income: true,
        bills: true,
        cardPayment: true,
        externalSpends: 4,
        recurringOut: [
          {
            desc: 'AUTO LOAN',
            amount: 70000,
            day: 5,
            type: 'ELECTRONIC DATA DEBIT',
          },
          {
            desc: 'UNIT TRUST INVESTMENT',
            amount: 40000,
            day: 26,
            type: 'PC-BILL PAYMENT',
          },
        ],
      },
    ],
  },
  /* -------------------------------------------------------------------------
   *  BANK ONLY  ·  MARSHA LYNCH  ·  31  ·  Kingston   (placeholder name)
   *  ---------------------------------------------------------------------
   *  Marsha is a few years into a public-sector job and paid by direct credit,
   *  about $260,000 a month. She rents rather than owns, a one-bedroom that
   *  takes $90,000, which is squarely where urban rents now sit, and she is
   *  still paying down her student loan through the Students' Loan Bureau at
   *  $18,000 a month. She does not use a credit card at all; everything runs
   *  through the one bank account. Light, water, internet, phone, life cover,
   *  the gym and the alarm leave by standing order.
   *
   *  On the side she tutors for CXC in the evenings, and that pays cash, which
   *  she lodges at the ABM in lumps when it builds up. Those machine deposits
   *  are not obviously her own earnings and should not be counted as income
   *  until she says so. Her card-at-the-till spending is ordinary and spread
   *  across the usual national places. Two moments stand out in the run: a
   *  furniture set she buys in one month, and a licence-and-fitness payment to
   *  the tax and transport offices. Once, an online order she cancelled comes
   *  back as a reversal into the account.
   *
   *  What the app should do with her: keep the cash and ABM deposits out of
   *  income by default and let her confirm the real ones; read the rent, the
   *  loan and the bills as the standing commitments they are; catch the
   *  furniture as a standout charge; and treat the reversal as a refund.
   * --------------------------------------------------------------------- */
  bankOnly: {
    firstName: 'Marsha',
    seed: 'bankonly',
    months: 8,
    hasCard: false,
    hasBank: true,
    monthlyIncome: 260000,
    incomeType: 'SCOTIA DIRECT CREDIT',
    incomeDesc: 'SCOTIA DIRECT CREDIT PAYROLL',
    cardTxnsPerMonth: 0,
    cardBehaviour: 'transactor',
    creditLimit: 0,
    cardAccount: '',
    spendWeights: {},
    accounts: [
      {
        number: '2210',
        currency: 'JMD',
        opening: 140000,
        income: true,
        bills: true,
        cashDeposits: true,
        externalSpends: 7,
        recurringOut: [
          {
            desc: 'RENT PAYMENT',
            amount: 90000,
            day: 1,
            type: 'ELECTRONIC DATA DEBIT',
          },
          {
            desc: 'SLB STUDENT LOAN',
            amount: 18000,
            day: 4,
            type: 'ELECTRONIC DATA DEBIT',
          },
        ],
        oneOffs: [
          {
            monthIndex: 3,
            desc: 'TROPICAL FURNITURE',
            amount: 168000,
            day: 14,
            type: 'POINT OF SALE',
            direction: 'out',
          },
          {
            monthIndex: 5,
            desc: 'DTOP ISLAND TRAFFIC',
            amount: 21500,
            day: 9,
            type: 'POINT OF SALE',
            direction: 'out',
          },
          {
            monthIndex: 6,
            desc: 'REFUND ONLINE PURCHASE',
            amount: 14200,
            day: 20,
            type: 'REVERSAL',
            direction: 'in',
          },
        ],
      },
    ],
  },
  /* -------------------------------------------------------------------------
   *  CARD ONLY  ·  DAMION REID  ·  35  ·  Kingston   (placeholder name)
   *  ---------------------------------------------------------------------
   *  Damion has only ever handed the app his credit-card statements, so there
   *  is no bank account in the picture, just the card and how he runs it. And
   *  he runs a balance. He spends freely, dining out, online orders, clothes,
   *  a night out, a flight now and then, and pays down only part of what he
   *  owes each month, so a balance rides forward and interest is charged on it
   *  every cycle, the pattern behind the record $94 billion Jamaicans now owe
   *  on cards. He keeps a few streaming services on the card, settles the odd
   *  tax bill through it, and one month makes a big electronics purchase that
   *  stands well clear of everything else. Returns come back as credits here
   *  and there.
   *
   *  What the app should do with him: read the card as a balance genuinely
   *  being carried, show the true cost of the interest and roughly how long it
   *  would take to clear at this rate, flag the electronics buy as the
   *  standout charge, and treat the returns as refunds. With no bank account
   *  imported, everything it says has to stand on the card alone.
   * --------------------------------------------------------------------- */
  cardOnly: {
    firstName: 'Damion',
    seed: 'cardonly',
    months: 8,
    hasCard: true,
    hasBank: false,
    monthlyIncome: 0,
    incomeType: 'SALARY',
    incomeDesc: 'SALARY PAYROLL',
    cardTxnsPerMonth: 26,
    cardBehaviour: 'revolver',
    interestRate: 0.045,
    targetUtilisation: 0.7,
    creditLimit: 250000,
    cardAccount: '4088',
    subscriptionCount: 3,
    refundChance: 0.35,
    cardOneOffs: [
      {
        monthIndex: 5,
        desc: 'BEST BUY',
        amount: 176000,
        day: 10,
        foreign: '1113.92 USD',
      },
    ],
    spendWeights: {
      Groceries: 2,
      'Dining & Takeout': 3,
      'Fuel & Transport': 2,
      'Hotels & Travel': 1,
      'Entertainment & Recreation': 2,
      'Courier & Shipping': 1,
      Telecom: 1,
      'Pharmacy & Health': 1,
      'Online Shopping': 3,
      'Retail & Department': 2,
      'Government & Tax': 1,
    },
    accounts: [],
  },
};

export {
  PERSONA_LABELS,
  CARD_MERCHANTS,
  CARD_AMOUNTS,
  BANK_POS_MERCHANTS,
  SUBSCRIPTION_POOL,
  BANK_BILLS,
  PERSONAS,
};
