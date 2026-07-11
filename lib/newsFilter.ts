/**
 * Cheap, deterministic relevance pre-filter — runs at INGEST, before anything is
 * stored or sent to the LLM. Its only job is to drop OBVIOUS non-business noise
 * (mostly from Moneycontrol's general /news/latest-news/ feed: sports, films,
 * astrology, crime, lifestyle, viral) so we don't spend an LLM call scoring it.
 *
 * High-precision by design: it matches only unambiguous noise. Borderline items
 * (policy, trade, geopolitics, macro) are LEFT IN and judged by the LLM — those
 * are real categories in our taxonomy. A little noise slipping through is fine;
 * dropping a real market story is not.
 */

// Whole-word noise terms in the headline.
const NOISE_TITLE = new RegExp(
  "\\b(" +
    "horoscope|zodiac|astrolog|rashifal|rashi|tarot|numerolog|vastu|" + // astrology
    "cricket|\\bipl\\b|world cup|\\bt20\\b|\\bodi\\b|\\btest match|football|fifa|la ?liga|" +
    "premier league|tennis|wimbledon|\\bopen\\b (?:final|semifinal)|olympic|badminton|hockey|kabaddi|" + // sports
    "box office|bollywood|hollywood|tollywood|movie|\\bfilm\\b|web series|trailer|teaser|" +
    "celebrity|\\bactor\\b|actress|singer|rapper|\\bott\\b release|" + // entertainment
    "recipe|weight loss|skincare|hair ?fall|home remedies|fashion|" + // lifestyle
    "obituary|passes away|dies at|\\bdeath\\b|murder|\\brape\\b|molest|dowry|" +
    "arrested|detained|\\bloot(?:ed)?\\b|robbery|cctv footage|" + // crime
    "ram temple|temple offering|temple trust|mandir|masjid|\\bidol\\b|festival|" +
    "wedding|marriage|birthday|anniversary|" + // religion / social
    "\\bpics?\\b|in pictures|photos:|watch:|viral|\\bmeme\\b|" + // viral / media
    "heatwave|rainfall|monsoon (?:hits|lashes)|earthquake|cyclone|\\bflood(?:s|ing)?\\b" + // weather/disaster
    ")\\b",
  "i",
);

// Moneycontrol URL sections that are unambiguously non-business.
const NOISE_URL = /moneycontrol\.com\/(news\/)?(sports|entertainment|astro|lifestyle|trends|photos|videos)\b/i;

/** True if the item is obvious non-business noise that should be dropped pre-LLM. */
export function isNoise(title: string, link: string | null): boolean {
  if (!title) return true;
  if (NOISE_TITLE.test(title)) return true;
  if (link && NOISE_URL.test(link)) return true;
  return false;
}
