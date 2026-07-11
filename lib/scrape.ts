/**
 * Generalized multi-source news scraper core. Each publisher is a SiteAdapter
 * (base URL + section list + an HTML parser); this core handles fetching,
 * novelty + freshness gating, and mapping to the shared NewsItem shape — so the
 * same output flows into storeNews() → analyzeNews() → the wall regardless of source.
 *
 * Novelty: per-source article id (seen-set), so we never re-emit a story.
 * Freshness: only emit articles PUBLISHED AFTER startup — robust to a section
 * failing on an early tick (its backlog is older than START, so it can't leak).
 * Both together = start fresh, follow new stories forward, restart-safe.
 *
 * Scraping HTML is more fragile than a feed (breaks if a site changes markup) and
 * is ToS-gray; each section fails independently and just logs, never blocks others.
 */
import { setDefaultResultOrder } from "node:dns";
import type { NewsItem, NewsCategory } from "./newsTypes";

setDefaultResultOrder("ipv4first");

const TIMEOUT_MS = Number(process.env.NEWS_TIMEOUT_MS ?? 12_000);
// Override with SINCE_ISO to backfill from a specific moment.
const START = process.env.SINCE_ISO ? Date.parse(process.env.SINCE_ISO) : Date.now();
// Emitted ids (keyed `site:id`), so a story is never posted twice. Bounded.
const seen = new Set<string>();

export interface RawArticle {
  id: string; // stable per-source id (novelty key + guid)
  title: string;
  link: string;
  summary: string | null;
  published_at: string | null; // ISO
}

export interface Section {
  path: string;
  category: NewsCategory;
}

export interface SiteAdapter {
  name: string; // short id, e.g. "ET", "MC"
  source: string; // wall label, e.g. "ET Wire", "Moneycontrol"
  base: string; // origin
  sections: Section[];
  parse: (html: string, base: string) => RawArticle[];
}

export const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Strip tags + decode the handful of entities Indian news pages use. */
export function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the UTC ISO instant for an IST (+05:30) wall-clock time. */
export function istToIso(y: number, mo: number, d: number, h: number, min: number): string {
  return new Date(Date.UTC(y, mo, d, h, min) - 5.5 * 3600_000).toISOString();
}

async function fetchHtml(url: string): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  throw new Error("unreachable");
}

function toNewsItem(a: RawArticle, site: SiteAdapter, sec: Section): NewsItem {
  return {
    source: site.source,
    feed_category: sec.category,
    guid: `${site.name.toLowerCase()}-${a.id}`,
    title: a.title,
    link: a.link,
    description: a.summary,
    published_at: a.published_at,
    raw: { site: site.name, id: a.id, section: sec.path },
  };
}

/** Scrape one site's sections; emit only unseen + genuinely-fresh articles. */
async function scrapeSite(site: SiteAdapter): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    site.sections.map((sec) => fetchHtml(site.base + sec.path).then((html) => ({ sec, arts: site.parse(html, site.base) }))),
  );
  const items: NewsItem[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { sec, arts } = r.value;
    for (const a of arts) {
      const key = `${site.name}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (a.published_at && Date.parse(a.published_at) > START) items.push(toNewsItem(a, site, sec));
    }
  }
  return items;
}

/** Scrape every configured site in parallel; returns only new, fresh articles. */
export async function fetchAllScraped(sites: SiteAdapter[]): Promise<NewsItem[]> {
  const all = await Promise.all(sites.map((s) => scrapeSite(s).catch(() => [] as NewsItem[])));
  if (seen.size > 6000) {
    const keep = [...seen].slice(-3000);
    seen.clear();
    for (const k of keep) seen.add(k);
  }
  return all.flat();
}

/** One-shot health check of every section — for `npm run news:check` (no gating). */
export async function checkAllSections(
  sites: SiteAdapter[],
): Promise<{ site: string; path: string; category: string; status: "ok" | "fail"; count: number; sample?: string }[]> {
  const rows: { site: string; path: string; category: string; status: "ok" | "fail"; count: number; sample?: string }[] = [];
  for (const site of sites) {
    const res = await Promise.allSettled(site.sections.map((sec) => fetchHtml(site.base + sec.path).then((h) => site.parse(h, site.base))));
    res.forEach((r, i) => {
      const sec = site.sections[i]!;
      rows.push(
        r.status === "fulfilled"
          ? { site: site.name, path: sec.path, category: sec.category, status: "ok", count: r.value.length, sample: r.value[0]?.title }
          : { site: site.name, path: sec.path, category: sec.category, status: "fail", count: 0 },
      );
    });
  }
  return rows;
}

export const sectionCount = (sites: SiteAdapter[]): number => sites.reduce((n, s) => n + s.sections.length, 0);
