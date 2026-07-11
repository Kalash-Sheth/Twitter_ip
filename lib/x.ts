/**
 * Live X (Twitter) poster — POST /2/tweets signed with OAuth 1.0a user context,
 * which is what the free tier requires for writes. Only constructed when all
 * four credentials are present (see getPoster). Untested until real creds are
 * added; isolated here so the rest of the pipeline never depends on it.
 */
import crypto from "node:crypto";
import type { Poster, PostResult } from "./poster";

const ENDPOINT = "https://api.twitter.com/2/tweets";

const enc = (s: string): string =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export class XPoster implements Poster {
  readonly mode = "x-live";

  private readonly apiKey = process.env.X_API_KEY!;
  private readonly apiSecret = process.env.X_API_SECRET!;
  private readonly accessToken = process.env.X_ACCESS_TOKEN!;
  private readonly accessSecret = process.env.X_ACCESS_SECRET!;

  /** Build the OAuth 1.0a Authorization header for a JSON-body POST. */
  private authHeader(): string {
    const oauth: Record<string, string> = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: crypto.randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: this.accessToken,
      oauth_version: "1.0",
    };

    // For a JSON body the signature covers only the oauth params (no body, no query).
    const paramString = Object.keys(oauth)
      .sort()
      .map((k) => `${enc(k)}=${enc(oauth[k]!)}`)
      .join("&");
    const base = ["POST", enc(ENDPOINT), enc(paramString)].join("&");
    const signingKey = `${enc(this.apiSecret)}&${enc(this.accessSecret)}`;
    const signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");

    const header: Record<string, string> = { ...oauth, oauth_signature: signature };
    return (
      "OAuth " +
      Object.keys(header)
        .sort()
        .map((k) => `${enc(k)}="${enc(header[k]!)}"`)
        .join(", ")
    );
  }

  async post(text: string): Promise<PostResult> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`X post failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: { id?: string } };
    const id = json.data?.id;
    if (!id) throw new Error(`X post: no id in response ${JSON.stringify(json)}`);
    return { id };
  }
}
