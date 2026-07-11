/** A normalized corporate announcement from either exchange, ready to store. */
export interface Announcement {
  source: "BSE" | "NSE";
  source_news_id: string; // per-source unique id (BSE NEWSID / NSE seq_id)
  scrip_cd: string; // BSE scrip code / NSE symbol
  company: string | null;
  nsurl: string | null;
  headline: string | null;
  subject: string;
  category: string | null;
  subcategory: string | null;
  critical: boolean;
  announcement_dt: string | null;
  dissem_dt: string | null;
  attachment_name: string | null; // BSE only (used to build Live/His URLs)
  pdf_url: string | null; // full URL (BSE built, NSE direct)
  dedup_key?: string; // cross-exchange dedup signature (filled by store)
  raw: unknown;
}
