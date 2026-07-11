/** A normalized news item from any RSS/Atom feed. */
export interface NewsItem {
  source: string; // publisher, e.g. "ET Markets", "Moneycontrol"
  feed_category: NewsCategory; // coarse bucket from the feed it came off (a hint)
  guid: string; // stable id per source (RSS <guid> or the article link)
  title: string;
  link: string | null;
  description: string | null; // RSS summary/description, plain-ish text
  published_at: string | null; // ISO
  dedup_key?: string;
  raw?: unknown;
}

/**
 * The canonical newswire taxonomy. The feed gives a coarse hint; the LLM assigns
 * the precise category from this list at analysis time (stored as ai_category).
 */
export const NEWS_CATEGORIES = [
  "Corporate News",
  "Corporate Filings",
  "Earnings & Results",
  "Markets",
  "Economy & Macro",
  "Policy & Regulation",
  "Capital Markets",
  "Banking & Financial Services",
  "Commodities",
  "Currencies",
  "Fixed Income & Bonds",
  "Global Markets",
  "Technology",
  "Startups & Venture Capital",
  "Mergers & Acquisitions",
  "Private Equity",
  "Real Estate",
  "Infrastructure",
  "Energy",
  "ESG & Sustainability",
  "Trade & Geopolitics",
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];
