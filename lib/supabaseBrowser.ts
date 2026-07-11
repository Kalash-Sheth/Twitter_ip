import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser client — anon key, read-only via RLS. Reads the same Supabase project
// the worker pipeline writes to. Null (not a thrown error) when env is missing,
// so the page can show a setup message instead of crashing.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && key);
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, key!)
  : null;

export interface Announcement {
  id: string;
  source: string;
  company: string | null;
  category: string | null;
  ai_category: string | null;
  subject: string;
  status: string;
  critical: boolean;
  impact_score: number | null;
  impact_reason: string | null;
  tweet_text: string | null;
  ingested_at: string;
  nsurl: string | null;
}

export interface TickerRow {
  id: string;
  publisher: string;
  category: string;
  title: string;
  link: string;
  published_at: string | null;
  ingested_at: string;
}

export interface AutoTweetRow {
  id: string;
  topic_key: string;
  headline: string;
  tweet_text: string;
  source_publisher: string | null;
  source_link: string | null;
  source_category: string | null;
  impact_score: number | null;
  x_tweet_id: string | null;
  posted_at: string;
}
