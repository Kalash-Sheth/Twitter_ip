/**
 * Per-publisher scraper adapters. Each defines its section pages + an HTML parser
 * that yields RawArticle[]; the core (lib/scrape.ts) does fetching, gating, and
 * mapping. The `category` on a section is only a HINT — the LLM assigns the precise
 * taxonomy label from each article's content.
 *
 * Add a publisher by writing a parser + adapter and pushing it into SITES.
 */
import type { SiteAdapter, RawArticle } from "./scrape";
import { decode, istToIso } from "./scrape";

// ============================================================================
//  Economic Times — section pages render a list of `<div class="eachStory">`.
//  Novelty id = the `articleshow/<msid>.cms` number (monotonic).
// ============================================================================
const MON3: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** "Jul 2, 2026, 09:31 PM IST" -> ISO. */
function parseEtTime(s: string): string | null {
  const m = s.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)/);
  if (!m) return null;
  const mo = MON3[m[1]!];
  if (mo === undefined) return null;
  let h = Number(m[4]);
  if (m[6] === "PM" && h !== 12) h += 12;
  if (m[6] === "AM" && h === 12) h = 0;
  return istToIso(Number(m[3]), mo, Number(m[2]), h, Number(m[5]));
}

function parseEt(html: string, base: string): RawArticle[] {
  const out: RawArticle[] = [];
  const blocks = html.split('<div class="eachStory"');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i]!;
    const hrefM = b.match(/href="(\/[a-z0-9/-]+\/articleshow\/(\d+)\.cms)"/i);
    if (!hrefM) continue;
    const nameM = b.match(/itemprop="name"[^>]*content="([^"]+)"/) || b.match(/content="([^"]+)"[^>]*itemprop="name"/);
    const anchorText = b.match(/<a[^>]*itemprop="url"[^>]*>([\s\S]*?)<\/a>/);
    const title = decode(nameM?.[1] ?? (anchorText ? anchorText[1]! : ""));
    if (!title || title.length < 12) continue;
    const timeM = b.match(/data-time="([^"]+)"/) || b.match(/>([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (?:AM|PM) IST)</);
    const pM = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({
      id: hrefM[2]!,
      title,
      link: base + hrefM[1]!,
      summary: pM ? decode(pM[1]!) || null : null,
      published_at: timeM ? parseEtTime(timeM[1]!) : null,
    });
  }
  return out;
}

export const ET: SiteAdapter = {
  name: "ET",
  source: "ET Wire",
  base: "https://economictimes.indiatimes.com",
  parse: parseEt,
  sections: [
    { path: "/markets/stocks/news", category: "Markets" },
    { path: "/markets/commodities/news", category: "Commodities" },
    { path: "/news/economy/policy", category: "Policy & Regulation" },
    { path: "/news/economy/finance", category: "Banking & Financial Services" },
    { path: "/news/economy/indicators", category: "Economy & Macro" },
    { path: "/news/economy/foreign-trade", category: "Trade & Geopolitics" },
    { path: "/news/international/business", category: "Global Markets" },
    { path: "/news/company/corporate-trends", category: "Corporate News" },
    { path: "/industry/banking/finance/banking", category: "Banking & Financial Services" },
    { path: "/industry/energy/power", category: "Energy" },
    { path: "/industry/healthcare/biotech/pharmaceuticals", category: "Corporate News" },
    { path: "/small-biz/sme-sector", category: "Startups & Venture Capital" },
    { path: "/industry/services/property-/-cstruction", category: "Real Estate" },
  ],
};

// ============================================================================
//  Moneycontrol — the /news/latest-news/ page renders `<h3 class="related_des">
//  <a href title>` paired with `<p class="related_date">Month DD, YYYY HH:MM AM`.
//  (Section pages like /news/business/markets/ use a different markup + are more
//  Akamai-prone; the latest-news page is the reliable one. It's a general feed —
//  the LLM + ≥60 threshold filter it down to market-relevant stories.)
//  Novelty id = the trailing number in the article URL.
// ============================================================================
const MON_FULL: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

/** "July 03, 2026 11:05 AM" (IST) -> ISO. */
function parseMcTime(s: string): string | null {
  const m = s.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)/);
  if (!m) return null;
  const mo = MON_FULL[m[1]!];
  if (mo === undefined) return null;
  let h = Number(m[4]);
  if (m[6] === "PM" && h !== 12) h += 12;
  if (m[6] === "AM" && h === 12) h = 0;
  return istToIso(Number(m[3]), mo, Number(m[2]), h, Number(m[5]));
}

function parseMc(html: string): RawArticle[] {
  const out: RawArticle[] = [];
  const parts = html.split('class="related_des"');
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i]!;
    const aM = c.match(/<a\s+href="([^"]+)"\s+title="([^"]+)"/);
    if (!aM) continue;
    const link = aM[1]!;
    const idM = link.match(/-(\d{6,})\.html/);
    if (!idM) continue;
    const title = decode(aM[2]!);
    if (!title || title.length < 12) continue;
    const dM = c.match(/class="related_date[^"]*">([^<]+)</);
    out.push({ id: idM[1]!, title, link, summary: null, published_at: dM ? parseMcTime(dM[1]!) : null });
  }
  return out;
}

export const MC: SiteAdapter = {
  name: "MC",
  source: "Moneycontrol",
  base: "https://www.moneycontrol.com",
  parse: parseMc,
  sections: [{ path: "/news/latest-news/", category: "Markets" }],
};

// ============================================================================
//  India Today Business — no RSS exists for this section (verified: no
//  autodiscovery link on the section page OR on individual article pages; their
//  official /rss index only lists 15 legacy magazine-era feeds, and the closest,
//  "Economy", is dead since March 2025). The page is Next.js though, so the
//  __NEXT_DATA__ blob embeds page_data.content[] directly — cleaner and more
//  stable than regex-scraping the rendered HTML.
//  Novelty id = the numeric `id` field (also the trailing number in the URL).
// ============================================================================
function parseItTime(s: string): string | null {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return istToIso(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

interface ItContentItem {
  id?: string | number;
  title_short?: string;
  canonical_url?: string;
  description_short?: string;
  datetime_published?: string;
}

function parseIndiaToday(html: string, base: string): RawArticle[] {
  const out: RawArticle[] = [];
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return out;
  let data: unknown;
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return out;
  }
  const content = (data as any)?.props?.pageProps?.initialState?.server?.page_data?.content as
    | ItContentItem[]
    | undefined;
  if (!Array.isArray(content)) return out;
  for (const item of content) {
    const id = item.id != null ? String(item.id) : "";
    const title = decode(item.title_short ?? "");
    const url = item.canonical_url ?? "";
    if (!id || !title || !url) continue;
    out.push({
      id,
      title,
      link: url.startsWith("http") ? url : base + url,
      summary: item.description_short ? decode(item.description_short) : null,
      published_at: item.datetime_published ? parseItTime(item.datetime_published) : null,
    });
  }
  return out;
}

export const INDIA_TODAY: SiteAdapter = {
  name: "IndiaToday",
  source: "India Today Business",
  base: "https://www.indiatoday.in",
  parse: parseIndiaToday,
  sections: [{ path: "/business", category: "Corporate News" }],
};

export const SITES: SiteAdapter[] = [ET, MC, INDIA_TODAY];
