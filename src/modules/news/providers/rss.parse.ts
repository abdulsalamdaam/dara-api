import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { NormalisedTweet } from "../news.types";
import { decodeHtmlEntities, detectLang, firstImageSrc, htmlToText, httpUrl } from "./html-text";

/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom → the same item shape the X providers produce.
 *
 * Parsed with fast-xml-parser, no DOM. Entity processing is OFF in the parser
 * (so a DOCTYPE cannot define or expand entities — no billion-laughs); text
 * nodes are decoded here, CDATA sections are taken verbatim, and descriptions
 * are then stripped to plain text.
 */

export interface ParsedFeed {
  format: "rss" | "atom" | "rdf";
  title: string | null;
  /** The feed's website (channel link / Atom alternate link), http(s) only. */
  siteUrl: string | null;
  items: NormalisedTweet[];
}

export class FeedParseError extends Error {}

/** How long a cleaned description may be on the item (the card shows ~220 chars). */
const SUMMARY_MAX = 1200;
const TITLE_MAX = 300;
const MAX_MEDIA = 4;

const ARRAYS = new Set(["item", "entry", "link", "enclosure", "media:content", "media:thumbnail", "media:group", "category", "atom:link"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "#cdata",
  textNodeName: "#text",
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAYS.has(name),
});

/** A node's text: decoded text parts + verbatim CDATA, in document order as far as the parser keeps it. */
function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return decodeHtmlEntities(node);
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    const parts: string[] = [];
    if (o["#text"] != null) parts.push(textOf(o["#text"]));
    const cd = o["#cdata"];
    if (cd != null) parts.push(...(Array.isArray(cd) ? cd : [cd]).map((c) => String(c)));
    return parts.join("");
  }
  return "";
}

function attr(node: unknown, name: string): string | null {
  if (!node || typeof node !== "object") return null;
  const v = (node as Record<string, unknown>)[`@_${name}`];
  return typeof v === "string" ? decodeHtmlEntities(v) : null;
}

function arr<T = unknown>(v: unknown): T[] {
  return v == null ? [] : Array.isArray(v) ? (v as T[]) : [v as T];
}

function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function isoDate(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  // A feed dated years ahead is wrong, not early; don't let it float to the top.
  if (d.getTime() > Date.now() + 2 * 86_400_000) return null;
  return d.toISOString();
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The dedupe key: sha256 of the guid (or Atom id), else of the link. A guid
 * that is not an absolute URL is only unique within its feed, so it is scoped
 * by the feed URL; a URL guid / link is global, which lets the same article
 * listed by two feeds collapse into one item.
 */
export function rssExternalId(feedUrl: string, guid: string | null, link: string | null): string {
  const g = (guid ?? "").trim();
  const key = g ? (/^https?:\/\//i.test(g) ? g : `${feedUrl}#${g}`) : (link ?? "").trim();
  return createHash("sha256").update(key).digest("hex");
}

/** Pick the best http(s) link from Atom `<link>`s: rel=alternate (or none) first. */
function atomLink(links: unknown, base?: string): string | null {
  const ls = arr<any>(links);
  const alt = ls.find((l) => !attr(l, "rel") || attr(l, "rel") === "alternate") ?? ls[0];
  if (!alt) return null;
  return httpUrl(attr(alt, "href") ?? textOf(alt), base);
}

function collectMedia(it: Record<string, any>, descriptionHtml: string, base?: string): NormalisedTweet["media"] {
  const urls: string[] = [];
  const add = (u: string | null) => {
    if (u && !urls.includes(u) && urls.length < MAX_MEDIA) urls.push(u);
  };
  const isImage = (n: unknown) => {
    const type = (attr(n, "type") ?? "").toLowerCase();
    const medium = (attr(n, "medium") ?? "").toLowerCase();
    if (medium) return medium === "image";
    if (type) return type.startsWith("image/");
    return /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(attr(n, "url") ?? "");
  };
  const groups = [it, ...arr<any>(it["media:group"])];
  for (const g of groups) {
    for (const m of arr(g["media:content"])) if (isImage(m)) add(httpUrl(attr(m, "url"), base));
  }
  for (const g of groups) for (const t of arr(g["media:thumbnail"])) add(httpUrl(attr(t, "url"), base));
  for (const e of arr(it.enclosure)) if (isImage(e)) add(httpUrl(attr(e, "url"), base));
  for (const l of arr(it.link)) if (attr(l, "rel") === "enclosure" && (attr(l, "type") ?? "").startsWith("image/")) add(httpUrl(attr(l, "href"), base));
  if (!urls.length) add(firstImageSrc(descriptionHtml));
  return urls.map((u) => ({ type: "photo", url: u, preview_url: u }));
}

/** Some CMSs put their URL in <title>; a host reads better as a name. */
function nameOrHost(title: string, url: string): string | null {
  if (!title || /^https?:\/\//i.test(title)) return host(url) ?? (title || null);
  return title;
}

/** Google News appends " - <publisher>" to every title; drop it when we know the publisher. */
function stripPublisherSuffix(title: string, publisher: string | null): string {
  if (!publisher) return title;
  const suffix = ` - ${publisher}`;
  return title.endsWith(suffix) && title.length > suffix.length + 5 ? title.slice(0, -suffix.length).trim() : title;
}

/** Drop a description that only repeats the title (Google News, many CMSs). */
function summaryBeyondTitle(summary: string, titles: string[], publisher: string | null): string {
  let s = summary;
  const t = titles.filter(Boolean).sort((a, b) => b.length - a.length).find((x) => s.startsWith(x));
  if (t) s = s.slice(t.length).trim();
  if (publisher && (s === publisher || s.endsWith(` ${publisher}`) && s.length - publisher.length < 3)) s = s.slice(0, s.length - publisher.length).trim();
  return s;
}

export interface ParseFeedOptions {
  feedUrl: string;
  /** Used as the author when an item names none. */
  displayName?: string | null;
}

/** Pure: feed XML text → items. Throws FeedParseError when it is not a feed. */
export function parseFeed(xml: string, opts: ParseFeedOptions): ParsedFeed {
  const head = xml.slice(0, 2000).toLowerCase();
  if (/<!doctype html|<html[\s>]/.test(head) && !/<(rss|feed|rdf:rdf)[\s>]/.test(head)) {
    throw new FeedParseError("not an RSS or Atom feed (the URL returned an HTML page)");
  }
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new FeedParseError(`not valid XML: ${(err as Error)?.message?.slice(0, 120)}`);
  }
  if (doc?.rss?.channel || doc?.channel) return parseRss(doc.rss?.channel ?? doc.channel, "rss", opts);
  if (doc?.["rdf:RDF"]) {
    const rdf = doc["rdf:RDF"];
    return parseRss({ ...(rdf.channel ?? {}), item: rdf.item }, "rdf", opts);
  }
  if (doc?.feed) return parseAtom(doc.feed, opts);
  throw new FeedParseError("not an RSS or Atom feed (no <rss>, <feed> or <rdf:RDF> root)");
}

function parseRss(ch: any, format: "rss" | "rdf", opts: ParseFeedOptions): ParsedFeed {
  const siteUrl = httpUrl(textOf(arr(ch?.link)[0]).trim(), opts.feedUrl);
  const feedTitle = nameOrHost(oneLine(htmlToText(textOf(ch?.title)), 200), siteUrl ?? opts.feedUrl);
  const author = opts.displayName || feedTitle;
  const items: NormalisedTweet[] = [];
  for (const it of arr<any>(ch?.item)) {
    const link = httpUrl(textOf(arr(it.link)[0]).trim(), siteUrl ?? opts.feedUrl)
      ?? (attr(it.guid, "isPermaLink") !== "false" ? httpUrl(textOf(it.guid).trim()) : null);
    if (!link) continue; // nothing to open — not a usable news item
    const guid = textOf(it.guid).trim() || (it["@_rdf:about"] as string | undefined) || null;
    const publisher = oneLine(textOf(it.source), 120) || null;
    const publisherUrl = httpUrl(attr(it.source, "url"));
    const rawTitle = oneLine(htmlToText(textOf(it.title)), TITLE_MAX);
    const title = stripPublisherSuffix(rawTitle, publisher);
    const descHtml = textOf(it["content:encoded"]) || textOf(it.description);
    // Google News descriptions only repeat the title and the publisher (lexicon.md §1): ignored.
    const googleNews = host(link) === "news.google.com";
    const desc = googleNews ? "" : summaryBeyondTitle(htmlToText(textOf(it.description) || descHtml), [rawTitle, title], publisher)
      .slice(0, SUMMARY_MAX);
    items.push(buildItem({
      feedUrl: opts.feedUrl, guid, link, title, summary: desc,
      postedAt: isoDate(textOf(it.pubDate) || textOf(it["dc:date"]) || textOf(it.published) || textOf(it.updated)),
      authorName: publisher ?? author,
      authorHost: host(publisherUrl) ?? host(siteUrl) ?? host(link),
      media: collectMedia(it, descHtml, link),
    }));
  }
  return { format, title: feedTitle, siteUrl, items };
}

function parseAtom(feed: any, opts: ParseFeedOptions): ParsedFeed {
  const siteUrl = atomLink(feed?.link, opts.feedUrl);
  const feedTitle = nameOrHost(oneLine(htmlToText(textOf(feed?.title)), 200), siteUrl ?? opts.feedUrl);
  const author = opts.displayName || feedTitle;
  const items: NormalisedTweet[] = [];
  for (const e of arr<any>(feed?.entry)) {
    const link = atomLink(e.link, siteUrl ?? opts.feedUrl);
    if (!link) continue;
    const rawTitle = oneLine(htmlToText(textOf(e.title)), TITLE_MAX);
    const descHtml = textOf(e.summary) || textOf(e.content);
    items.push(buildItem({
      feedUrl: opts.feedUrl, guid: textOf(e.id).trim() || null, link, title: rawTitle,
      summary: summaryBeyondTitle(htmlToText(descHtml), [rawTitle], null).slice(0, SUMMARY_MAX),
      postedAt: isoDate(textOf(e.published) || textOf(e.updated)),
      authorName: author,
      authorHost: host(siteUrl) ?? host(link),
      media: collectMedia(e, descHtml, link),
    }));
  }
  return { format: "atom", title: feedTitle, siteUrl, items };
}

function buildItem(p: {
  feedUrl: string; guid: string | null; link: string; title: string; summary: string;
  postedAt: string | null; authorName: string | null; authorHost: string | null; media: NormalisedTweet["media"];
}): NormalisedTweet {
  const text = [p.title, p.summary].filter(Boolean).join("\n\n");
  return {
    id: rssExternalId(p.feedUrl, p.guid, p.link),
    url: p.link,
    text: text || p.link,
    lang: detectLang(p.title || p.summary),
    postedAt: p.postedAt,
    // For RSS the "handle" is the publisher's host (argaam.com) — what the card
    // shows as "Read at …" and what the web derives the favicon from.
    authorHandle: p.authorHost ?? "",
    authorName: p.authorName,
    authorAvatarUrl: null,
    media: p.media,
    metrics: null,
    title: p.title || null,
    summary: p.summary || null,
  };
}
