import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import dns from "node:dns";
import type { AddressInfo } from "node:net";
import { FeedParseError, parseFeed, rssExternalId } from "./providers/rss.parse";
import { decodeBody, RssProvider } from "./providers/rss.provider";
import { detectLang, htmlToText } from "./providers/html-text";
import {
  assertPublicHost, checkUrlShape, guardedLookup, isBlockedAddress, nodeTransport, safeGet, SafeFetchError,
  type RawResponse,
} from "./providers/safe-fetch";
import { ProviderError } from "./news.types";

const fx = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");
const FEED = "https://example.com/feed.xml";
const publicDns = async () => [{ address: "93.184.215.14", family: 4 }];

describe("parseFeed — recorded feeds", () => {
  it("Google News RSS: publisher suffix stripped, publisher as author, no echo summary", () => {
    const f = parseFeed(fx("rss-google-news.xml"), { feedUrl: FEED });
    assert.equal(f.format, "rss");
    assert.equal(f.items.length, 3);
    const t = f.items[0];
    assert.equal(t.title, "الهيئة العامة للعقار تبدأ أعمال التسجيل لـ 22.9 ألف قطعة عقارية في مناطق القصيم والرياض");
    assert.equal(t.authorName, "صحيفة مال");
    assert.equal(t.authorHandle, "maaal.com");
    assert.equal(t.summary, null, "the description only repeated the title + publisher");
    assert.match(t.url, /^https:\/\/news\.google\.com\/rss\/articles\//, "Google News links are kept as-is");
    assert.match(t.id, /^[0-9a-f]{64}$/);
    assert.equal(t.lang, "ar");
    assert.equal(t.postedAt, "2026-09-21T11:12:25.000Z");
    assert.equal(t.metrics, null);
    assert.equal(t.text, t.title);
  });

  it("publisher RSS: CDATA with entity-escaped HTML is stripped to text, media:content kept", () => {
    const f = parseFeed(fx("rss-alyaum.xml"), { feedUrl: FEED });
    assert.equal(f.title, "صحيفة اليوم");
    assert.equal(f.siteUrl, "https://www.alyaum.com/");
    const t = f.items[0];
    assert.equal(t.title, "السيارات الكهربائية تعوض انهيار مبيعات مركبات البنزين والديزل الأوروبية");
    assert.ok(t.summary!.startsWith("واصل الطلب على السيارات الكهربائية"));
    assert.ok(t.summary!.includes("«إيسا»"), "&laquo;/&raquo; decoded");
    assert.ok(!/[<>]|&[a-z]+;|href=/.test(t.summary!), `no markup left: ${t.summary!.slice(0, 200)}`);
    assert.deepEqual(t.media, [{ type: "photo", url: "https://www.alyaum.com/uploads/images/2026/09/24/3132686.jpg", preview_url: "https://www.alyaum.com/uploads/images/2026/09/24/3132686.jpg" }]);
    assert.equal(t.authorName, "صحيفة اليوم");
    assert.equal(t.text, `${t.title}\n\n${t.summary}`);
  });

  it("Atom: alternate link, html title decoded, published date, feed site", () => {
    const f = parseFeed(fx("atom-verge.xml"), { feedUrl: FEED, displayName: "The Verge (admin name)" });
    assert.equal(f.format, "atom");
    assert.equal(f.title, "The Verge");
    assert.equal(f.siteUrl, "https://www.theverge.com/");
    assert.equal(f.items.length, 2);
    const t = f.items[0];
    assert.equal(t.title, "Roku’s first OLED TVs are up to $400 off, starting at $699");
    assert.equal(t.url, "https://www.theverge.com/gadgets/1000859/roku-pro-series-oled-nothing-phone-4a-pro-deal-sale");
    assert.equal(t.postedAt, "2026-09-25T18:18:57.000Z");
    assert.equal(t.lang, "en");
    assert.equal(t.authorName, "The Verge (admin name)", "the admin's display name wins");
    assert.equal(t.id, rssExternalId(FEED, "https://www.theverge.com/?p=1000859", null));
  });
});

describe("parseFeed — edge cases", () => {
  const rss = (items: string, ns = "") =>
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" ${ns}><channel><title>T</title><link>https://site.example/</link>${items}</channel></rss>`;

  it("drops items without an http(s) link (javascript:, data:, none)", () => {
    const f = parseFeed(rss(`
      <item><title>a</title><link>javascript:alert(1)</link></item>
      <item><title>b</title><link>data:text/html,x</link></item>
      <item><title>c</title></item>
      <item><title>d</title><link>/relative/path</link></item>`), { feedUrl: FEED });
    assert.deepEqual(f.items.map((i) => i.url), ["https://site.example/relative/path"]);
  });

  it("collects images from enclosure, media:content, media:thumbnail and <img>, http(s) only", () => {
    const f = parseFeed(rss(`
      <item><title>a</title><link>https://s.example/1</link>
        <enclosure url="https://img.example/e.jpg" type="image/jpeg" length="1"/>
        <enclosure url="https://img.example/a.mp3" type="audio/mpeg" length="1"/>
        <media:content url="https://img.example/m.png" medium="image"/>
        <media:content url="javascript:x" medium="image"/>
        <media:thumbnail url="https://img.example/t.webp"/>
      </item>
      <item><title>b</title><link>https://s.example/2</link>
        <description>&lt;p&gt;&lt;img src="https://img.example/inline.jpg"&gt; text&lt;/p&gt;</description></item>`,
      'xmlns:media="http://search.yahoo.com/mrss/"'), { feedUrl: FEED });
    assert.deepEqual(f.items[0].media.map((m) => m.url), ["https://img.example/m.png", "https://img.example/t.webp", "https://img.example/e.jpg"]);
    assert.deepEqual(f.items[1].media.map((m) => m.url), ["https://img.example/inline.jpg"]);
    assert.equal(f.items[1].summary, "text");
  });

  it("does not expand DOCTYPE entities (no billion laughs, no XXE)", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>
      <rss version="2.0"><channel><title>T</title><item><title>&b; x</title><link>https://s.example/1</link></item></channel></rss>`;
    const f = parseFeed(xml, { feedUrl: FEED });
    assert.ok(!f.items[0].title!.includes("AAAA"));
    const xxe = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>
      <rss version="2.0"><channel><title>T</title><item><title>&x;</title><link>https://s.example/1</link></item></channel></rss>`;
    assert.throws(() => parseFeed(xxe, { feedUrl: FEED }), FeedParseError);
  });

  it("scopes a non-URL guid to the feed; a URL guid / link is global", () => {
    assert.notEqual(rssExternalId("https://a.example/f", "123", null), rssExternalId("https://b.example/f", "123", null));
    assert.equal(rssExternalId("https://a.example/f", "https://x.example/p/1", null), rssExternalId("https://b.example/f", "https://x.example/p/1", null));
    assert.equal(rssExternalId("https://a.example/f", null, "https://x.example/p/1"), rssExternalId("https://b.example/f", "", "https://x.example/p/1"));
  });

  it("reads RSS 1.0 (RDF) and rejects HTML pages and non-feeds", () => {
    const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>R</title><link>https://r.example/</link></channel>
      <item rdf:about="https://r.example/1"><title>One</title><link>https://r.example/1</link><dc:date>2026-09-20T10:00:00Z</dc:date></item></rdf:RDF>`;
    const f = parseFeed(rdf, { feedUrl: FEED });
    assert.equal(f.format, "rdf");
    assert.equal(f.items[0].postedAt, "2026-09-20T10:00:00.000Z");
    assert.throws(() => parseFeed("<!DOCTYPE html><html><body>hi</body></html>", { feedUrl: FEED }), FeedParseError);
    assert.throws(() => parseFeed("<note><to>x</to></note>", { feedUrl: FEED }), /not an RSS or Atom feed/);
  });

  it("a feed title that is a URL becomes the host", () => {
    const f = parseFeed(rss("").replace("<title>T</title>", "<title>https://www.okaz.com.sa</title>"), { feedUrl: FEED });
    assert.equal(f.title, "site.example");
  });
});

describe("html text + language", () => {
  it("strips tags, scripts, comments and decodes entities", () => {
    assert.equal(htmlToText(`<p>Hello&nbsp;<b>world</b></p><script>alert(1)</script><!-- c --><br/>&#x627;&#1604; &amp; more`), "Hello world ال & more");
    assert.equal(htmlToText("&lt;p&gt;escaped &amp;amp; html&lt;/p&gt;"), "escaped & html");
  });
  it("detects Arabic vs English", () => {
    assert.equal(detectLang("الهيئة العامة للعقار REGA"), "ar");
    assert.equal(detectLang("Saudi REGA launches new rules"), "en");
    assert.equal(detectLang("2026 — 12%"), null);
  });
  it("decodes the body with the declared charset", () => {
    const win1256 = Buffer.from([0xc7, 0xe1, 0xda, 0xde, 0xc7, 0xd1]); // «العقار» in windows-1256
    assert.equal(decodeBody(win1256, "text/xml; charset=windows-1256"), "العقار");
    const decl = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1256"?>'), win1256]);
    assert.ok(decodeBody(decl, "text/xml").endsWith("العقار"));
    assert.equal(decodeBody(Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]), null), "ok");
  });
});

describe("RssProvider", () => {
  function transport(responses: Array<Partial<RawResponse> & { status: number }>, seen: Array<{ url: string; headers: Record<string, string> }> = []) {
    return async (url: URL, headers: Record<string, string>) => {
      seen.push({ url: url.toString(), headers });
      const r = responses.shift();
      if (!r) throw new Error("unexpected request");
      return { headers: {}, body: Buffer.alloc(0), ...r } as RawResponse;
    };
  }

  it("sends conditional headers and reports 304 as not modified", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const p = new RssProvider({ resolve: publicDns, transport: transport([{ status: 304 }], seen) });
    const r = await p.fetchFeed(FEED, { etag: '"abc"', lastModified: "Fri, 25 Sep 2026 10:00:00 GMT", max: 10 });
    assert.equal(r.notModified, true);
    assert.equal(r.items.length, 0);
    assert.equal(seen[0].headers["if-none-match"], '"abc"');
    assert.equal(seen[0].headers["if-modified-since"], "Fri, 25 Sep 2026 10:00:00 GMT");
    assert.match(seen[0].headers["user-agent"], /DaraNewsBot/);
  });

  it("keeps new validators, applies the lookback window and the cap, newest first", async () => {
    const body = Buffer.from(fx("rss-google-news.xml"));
    const p = new RssProvider({
      resolve: publicDns,
      transport: transport([{ status: 200, body, headers: { etag: '"v2"', "last-modified": "Sat, 26 Sep 2026 00:00:00 GMT", "content-type": "application/rss+xml; charset=UTF-8" } }]),
    });
    const r = await p.fetchFeed(FEED, { since: new Date("2026-09-21T11:30:00Z"), max: 1 });
    assert.equal(r.etag, '"v2"');
    assert.equal(r.lastModified, "Sat, 26 Sep 2026 00:00:00 GMT");
    assert.equal(r.items.length, 1);
    assert.ok(r.items[0].postedAt! >= "2026-09-21T11:30:00.000Z");
    assert.equal(r.skipped, 2);
  });

  it("maps failures onto provider error kinds", async () => {
    const run = (res: { status: number; body?: Buffer }) =>
      new RssProvider({ resolve: publicDns, transport: transport([res]) }).fetchFeed(FEED, { max: 5 });
    await assert.rejects(run({ status: 404 }), (e: unknown) => e instanceof ProviderError && e.kind === "not_found");
    await assert.rejects(run({ status: 429 }), (e: unknown) => e instanceof ProviderError && e.kind === "rate_limit");
    await assert.rejects(run({ status: 200, body: Buffer.from("<!doctype html><html></html>") }), (e: unknown) =>
      e instanceof ProviderError && e.kind === "other" && /HTML page/.test(e.message));
    const blocked = new RssProvider({ resolve: async () => [{ address: "10.1.2.3", family: 4 }], transport: transport([]) });
    await assert.rejects(blocked.fetchFeed(FEED, { max: 5 }), (e: unknown) => e instanceof ProviderError && /private or reserved/.test(e.message));
  });
});

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local, CGNAT, multicast and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "::ffff:7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "ff02::1", "not-an-ip",
    ]) assert.equal(isBlockedAddress(ip), true, ip);
    for (const ip of ["8.8.8.8", "93.184.215.14", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it("rejects bad URL shapes before any DNS", () => {
    const bad: Array<[string, RegExp]> = [
      ["ftp://example.com/feed", /only http and https/],
      ["file:///etc/passwd", /only http and https/],
      ["https://user:pw@example.com/feed", /user name or password/],
      ["https://example.com:8080/feed", /standard ports/],
      ["http://localhost/feed", /not a public/],
      ["http://metadata.internal/", /not a public/],
      ["http://intranet/", /not a public/],
      ["http://127.0.0.1/feed", /private or reserved/],
      ["http://[::1]/feed", /private or reserved/],
      ["http://169.254.169.254/latest/meta-data", /private or reserved/],
      ["http://2130706433/", /private or reserved/], // 127.0.0.1 as a decimal — WHATWG URL normalises it
      ["not a url", /not a valid URL/],
    ];
    for (const [u, re] of bad) assert.throws(() => checkUrlShape(u), (e: unknown) => e instanceof SafeFetchError && re.test(e.message), u);
    assert.equal(checkUrlShape("https://www.argaam.com/ar/rss").hostname, "www.argaam.com");
  });

  it("rejects a host that resolves to any private address", async () => {
    await assert.rejects(assertPublicHost("evil.example", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]),
      /private or reserved/);
    await assertPublicHost("ok.example", publicDns);
  });

  it("re-checks every redirect hop", async () => {
    const hops = (loc: string) => async () => ({ status: 302, headers: { location: loc }, body: Buffer.alloc(0) });
    await assert.rejects(safeGet("https://ok.example/f", { resolve: publicDns, transport: hops("http://127.0.0.1/admin") }),
      (e: unknown) => e instanceof SafeFetchError && e.kind === "blocked");
    const resolve = async (h: string) => (h === "inside.example" ? [{ address: "192.168.0.10", family: 4 }] : publicDns());
    await assert.rejects(safeGet("https://ok.example/f", { resolve, transport: hops("https://inside.example/") }),
      (e: unknown) => e instanceof SafeFetchError && e.kind === "blocked");
    await assert.rejects(safeGet("https://ok.example/f", { resolve: publicDns, transport: hops("ftp://ok.example/") }),
      (e: unknown) => e instanceof SafeFetchError && e.kind === "invalid_url");
    await assert.rejects(safeGet("https://ok.example/f", { resolve: publicDns, transport: hops("https://ok.example/again"), maxRedirects: 3 }),
      (e: unknown) => e instanceof SafeFetchError && e.kind === "too_many_redirects");
    let n = 0;
    const ok = await safeGet("https://ok.example/f", {
      resolve: publicDns,
      transport: async () => (n++ === 0 ? { status: 301, headers: { location: "/moved" }, body: Buffer.alloc(0) } : { status: 200, headers: {}, body: Buffer.from("x") }),
    });
    assert.equal(ok.url, "https://ok.example/moved");
  });

  it("the connect-time lookup refuses private answers (DNS rebinding)", async () => {
    const lookup = guardedLookup(async () => [{ address: "10.0.0.7", family: 4 }]);
    const err = await new Promise<any>((res) => lookup("rebind.example", {}, (e: any) => res(e)));
    assert.equal(err?.code, "EBLOCKED");
  });

  it("a real request to a loopback server is refused", async () => {
    const server = http.createServer((_q, r) => r.end("secret"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    after(() => server.close());
    const port = (server.address() as AddressInfo).port;
    await assert.rejects(safeGet(`http://127.0.0.1:${port}/`), (e: unknown) => e instanceof SafeFetchError && e.kind === "blocked");
    await assert.rejects(safeGet("http://localhost/"), (e: unknown) => e instanceof SafeFetchError && e.kind === "blocked");
  });
});

describe("transport caps (local server, guard bypassed on purpose)", () => {
  const plainLookup = ((h: string, o: any, cb: any) => dns.lookup(h, o, cb)) as any;
  let server: http.Server;
  let base = "";
  const ready = new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(Buffer.alloc(3000, 97));
      } else if (req.url === "/bomb") {
        res.writeHead(200, { "content-type": "text/xml", "content-encoding": "gzip" });
        res.end(zlib.gzipSync(Buffer.alloc(200_000, 97)));
      } else if (req.url === "/slow") {
        res.writeHead(200);
        res.write("<");
      } else {
        res.writeHead(200, { "content-type": "text/xml", "content-encoding": "gzip" });
        res.end(zlib.gzipSync(Buffer.from("<rss/>")));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  after(() => server.close());

  it("decompresses, and caps size before and after decompression", async () => {
    await ready;
    const t = nodeTransport(1000);
    const ok = await t(new URL(`${base}/ok`), {}, plainLookup, 5000);
    assert.equal(ok.body.toString(), "<rss/>");
    await assert.rejects(t(new URL(`${base}/big`), {}, plainLookup, 5000), (e: unknown) => e instanceof SafeFetchError && e.kind === "too_large");
    await assert.rejects(t(new URL(`${base}/bomb`), {}, plainLookup, 5000), (e: unknown) => e instanceof SafeFetchError && e.kind === "too_large");
  });

  it("times out a response that never finishes", async () => {
    await ready;
    const t = nodeTransport(1000);
    await assert.rejects(t(new URL(`${base}/slow`), {}, plainLookup, 300), (e: unknown) => e instanceof SafeFetchError && e.kind === "timeout");
  });
});
