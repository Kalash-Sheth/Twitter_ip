/**
 * Source list for the Ticker engine — raw RSS aggregation, no AI, no posting.
 * Every feed here was verified live (curl) before being added; each is pinned to
 * ONE of our four target categories at the feed level (no keyword classification
 * needed — the feed's own section already tells us the category).
 *
 * Known-dead/blocked-from-server feeds are deliberately NOT included:
 * Business Standard, Zee Business, NDTV Profit, Moneycontrol (all 403/Akamai from
 * this environment), Financial Express (RSS now redirects to an HTML page or 410s),
 * CNBC-TV18 (RSS API returns 400), and ANI Business (feed resolves but content is
 * stale — articles dated ~21 months old, not actually updating). Some of the
 * blocked ones may work from a residential IP (same reason NSE only works from
 * your Mac) — worth re-testing with `ticker:check` if you run this on your Mac.
 */
export type TickerCategory = "Markets" | "Indian Economy" | "Business" | "Finance";

/**
 * Maps the Newswire scraper's broader 21-category taxonomy (lib/newsTypes.ts,
 * used by the ET+Moneycontrol HTML scraper) down to Ticker's 4 buckets — lets
 * the same ET/MC scraper feed both engines without duplicating any fetch code.
 */
const SCRAPED_CATEGORY_MAP: Record<string, TickerCategory> = {
  Markets: "Markets",
  "Capital Markets": "Markets",
  Commodities: "Markets",
  Currencies: "Markets",
  "Global Markets": "Markets",
  "Economy & Macro": "Indian Economy",
  "Policy & Regulation": "Indian Economy",
  "Trade & Geopolitics": "Indian Economy",
  "Banking & Financial Services": "Finance",
  "Fixed Income & Bonds": "Finance",
  "Private Equity": "Finance",
};

/** Anything not explicitly mapped above falls back to Business (the catch-all). */
export function mapScrapedCategory(feedCategory: string): TickerCategory {
  return SCRAPED_CATEGORY_MAP[feedCategory] ?? "Business";
}

/**
 * Positive keyword allow-list for scraped sources with no section-level scoping
 * (i.e. Moneycontrol's single general "latest news" feed). Unlike the RSS feeds
 * (each pinned to a real business/markets/economy/finance section) or ET's
 * scraper (each section IS one of our categories), MC's feed is a firehose of
 * everything — the existing isNoise() deny-list only strips OBVIOUS junk
 * (sports/astrology/crime), which isn't enough when there's no LLM downstream
 * to catch borderline non-business items (war casualties, gadget reviews, etc).
 * Require a real hit here before an MC item is allowed into the Ticker at all.
 */
const BUSINESS_RELEVANT = new RegExp(
  "\\b(" +
    // Markets — bare "stock" dropped (matched "expired stock" at a shop, an inventory
    // sense, not stock market); "stocks?" plural/compound forms are unambiguous enough.
    "\\bstocks\\b|stock market|share price|shares?|nifty|sensex|\\bipo\\b|equit|market|rally|" +
    "sell-?off|\\bindex\\b|bourse|\\bfii\\b|\\bdii\\b|" +
    // Business
    "acqui|merger|takeover|stake|\\bdeal\\b|earnings|results?|profit|revenue|order win|contract|expansion|" +
    "capex|layoff|job cuts|hiring|headcount|workforce|partnership|\\bjv\\b|company|corporate|startup|" +
    "funding round|valuation|" +
    // Finance
    "\\bbank\\b|nbfc|\\bnpa\\b|mutual fund|insuranc|\\bbond\\b|\\brbi\\b|credit rating|dividend|buyback|" +
    "fundrais|\\bqip\\b|loan|interest rate|" +
    // Indian Economy
    "\\bgdp\\b|inflation|\\bcpi\\b|\\bwpi\\b|repo rate|fiscal|deficit|\\brupee\\b|\\bexport|\\bimport|" +
    "\\bgst\\b|\\bfdi\\b|\\bbudget\\b|\\bwto\\b|tariff|trade (deal|pact|war)" +
    ")\\b",
  "i",
);

/** True if the text hits at least one real business/markets/finance/economy term. */
export function isBusinessRelevant(text: string): boolean {
  return BUSINESS_RELEVANT.test(text);
}

export interface TickerFeed {
  publisher: string;
  url: string;
  category: TickerCategory;
}

export const TICKER_FEEDS: TickerFeed[] = [
  // ---- Markets ----
  { publisher: "ET Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", category: "Markets" },
  { publisher: "Mint Markets", url: "https://www.livemint.com/rss/markets", category: "Markets" },
  { publisher: "BusinessLine Markets", url: "https://www.thehindubusinessline.com/markets/feeder/default.rss", category: "Markets" },
  { publisher: "BusinessLine Portfolio", url: "https://www.thehindubusinessline.com/portfolio/feeder/default.rss", category: "Markets" },

  // ---- Indian Economy ----
  { publisher: "ET Economy", url: "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", category: "Indian Economy" },
  { publisher: "Mint Economy", url: "https://www.livemint.com/rss/economy", category: "Indian Economy" },
  { publisher: "BusinessLine Economy", url: "https://www.thehindubusinessline.com/economy/feeder/default.rss", category: "Indian Economy" },

  // ---- Business ----
  { publisher: "ET Industry", url: "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms", category: "Business" },
  { publisher: "Mint Companies", url: "https://www.livemint.com/rss/companies", category: "Business" },
  { publisher: "BusinessLine Companies", url: "https://www.thehindubusinessline.com/companies/feeder/default.rss", category: "Business" },
  { publisher: "TOI Business", url: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms", category: "Business" },
  // ET NOW has no dedicated business feed — this is their sitewide latest (FIFA
  // World Cup, celebrity home purchases, etc. mixed in). Gated through
  // isBusinessRelevant() in worker/ticker.ts, same treatment as Moneycontrol.
  { publisher: "ET Now", url: "https://www.etnownews.com/feeds/gns-etn-latest.xml", category: "Business" },
  // India Today: NO working RSS exists (verified: no autodiscovery link on the
  // section page or individual article pages; their official feed index only
  // has 15 dead magazine-era feeds). Fetched via the scraper instead — see
  // lib/newsSites.ts's INDIA_TODAY adapter (parses Next.js __NEXT_DATA__ JSON,
  // genuinely business content, verified live: TCS results, Sensex/Nifty, etc).

  // ---- Finance ----
  { publisher: "Mint Money", url: "https://www.livemint.com/rss/money", category: "Finance" },
  { publisher: "BusinessLine Money & Banking", url: "https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss", category: "Finance" },

  // ---- Indian Economy (govt source) ----
  // PIB's general press-release feed (ModId=6, ALL ministries — no finance-specific
  // ModId found). Items carry no pubDate, so freshness falls back to ingest time.
  { publisher: "PIB (Govt of India)", url: "https://pib.gov.in/RssMain.aspx?ModId=6&Reg=3&Lang=1", category: "Indian Economy" },
];
