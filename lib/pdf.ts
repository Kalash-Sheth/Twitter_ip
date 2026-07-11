/**
 * Download a BSE filing PDF and extract its text.
 *
 * Fresh filings are served from AttachLive; once BSE archives them they move to
 * AttachHis (and AttachLive starts 404ing). We try Live first, fall back to His,
 * so the same code works for both real-time and back-filled announcements.
 */
import { setDefaultResultOrder } from "node:dns";
import { extractText, getDocumentProxy } from "unpdf";
import { RetryableError } from "./errors";

// Same IPv4 guard as the BSE client — the PDF host (www.bseindia.com) also
// resolves to an IPv6 address that hangs in some environments.
setDefaultResultOrder("ipv4first");

const DOWNLOAD_TIMEOUT_MS = 20_000;

const BASES = [
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive",
  "https://www.bseindia.com/xml-data/corpfiling/AttachHis",
];

const HEADERS: Record<string, string> = {
  Referer: "https://www.bseindia.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** Download the attachment, trying Live then His. Returns the PDF bytes. */
export async function downloadPdf(attachmentName: string): Promise<Uint8Array> {
  let lastErr = "";
  for (const base of BASES) {
    let res: Response;
    try {
      res = await fetch(`${base}/${attachmentName}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (e) {
      // Network/timeout on the download — transient, retry the whole filing later.
      throw new RetryableError(`PDF download network: ${e instanceof Error ? e.message : String(e)}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("pdf")) {
      return new Uint8Array(await res.arrayBuffer());
    }
    if (res.status >= 500) throw new RetryableError(`PDF host ${res.status}`); // transient
    lastErr = `${base} -> ${res.status} ${type}`;
  }
  // Both Live and His returned non-PDF/4xx — genuinely not available.
  throw new Error(`PDF not found for ${attachmentName} (${lastErr})`);
}

// pdfjs (inside unpdf) prints harmless font-parsing chatter ("Warning: TT:
// undefined function…", "invalid function id…") straight to console. The text
// still extracts fine — we just filter those lines so the worker log stays clean.
const isPdfFontNoise = (a: unknown) => {
  const s = typeof a === "string" ? a : "";
  return s.startsWith("Warning: TT") || s.includes("undefined function") || s.includes("invalid function id");
};

/** Extract text from PDF bytes. Returns trimmed, whitespace-collapsed text. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => { if (!isPdfFontNoise(a[0])) origLog(...a); };
  console.warn = (...a: unknown[]) => { if (!isPdfFontNoise(a[0])) origWarn(...a); };
  try {
    const doc = await getDocumentProxy(bytes);
    const { text } = await extractText(doc, { mergePages: true });
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

/** Download from a full URL (NSE serves direct nsearchives.* links). */
async function downloadUrl(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (e) {
    throw new RetryableError(`PDF download network: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 500) throw new RetryableError(`PDF host ${res.status}`);
  if (!res.ok) throw new Error(`PDF not found at ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** BSE convenience: attachment name (Live→His) -> extracted text. */
export async function pdfTextFor(attachmentName: string): Promise<string> {
  return extractPdfText(await downloadPdf(attachmentName));
}

/** NSE convenience: full PDF URL -> extracted text. */
export async function pdfTextForUrl(url: string): Promise<string> {
  return extractPdfText(await downloadUrl(url));
}
