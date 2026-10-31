import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { samaAdapter, samaSource } from '../src/backend/adapters/sama.js';
import { dfsaAdapter, dfsaSource } from '../src/backend/adapters/dfsa.js';
import { cbkListingSource, cbkSource } from '../src/backend/adapters/cbk.js';
import { bogAdapter, bogSource, bogNoticesAdapter, bogNoticesSource } from '../src/backend/adapters/bog.js';
import { routeDocument } from '../src/backend/document-routing.js';
import { extractText } from '../src/backend/extract.js';

const samaUrl = 'https://rulebook.sama.gov.sa/en/node/11111';
const samaFinal = 'https://rulebook.sama.gov.sa/en/integration-security-council-resolutions-notification-system';
const dfsaUrl = 'https://www.dfsa.ae/news/notice-amendments-legislation-october-2026';
const samaDetail = `<html><body><nav>Navigation must not enter cited text</nav><article class="node--type-book"><h2 class="page-title"><span class="field--name-title">Security Council Resolution Circular</span></h2><table class="info-table"><tr><td>No: 482028988 Date(g): 1/10/2026 | Date(h): 20/4/1448 Status: In-Force</td></tr></table><content><div class="node__content"><h3>Requirements</h3><p>Banks must screen customers against the designated list before opening an account.</p><p>Any matched account must be frozen and reported to the authority within the specified reporting window.</p><script>window.evil=true</script></div></content></article></body></html>`;
const dfsaDetail = `<html><body><header>Navigation must not enter cited text</header><div class="news-content-wrap"><div class="info-block-wrap"><h1>Notice of Amendments to Legislation: October 2026</h1><h6 class="date">01 Oct 2026, 06:21 pm</h6><div class="animation-hidden fade-up delay-800"><h2>Rulebook amendments</h2><p>The DFSA has amended the Rulebook to clarify reporting requirements for authorised firms.</p><p>Authorised firms must review the amended rules and apply the reporting requirements from the stated commencement date.</p></div></div></div></body></html>`;
const listing = (link: string) => `<html><body><div class="news-listing-block"><a class="item" href="${link}"><span class="tag">Notice of Amendment</span><span class="title">Notice of Amendments to Legislation: October 2026</span></a></div></body></html>`;

test('Kenyan current listing is a distinct configured source from the readable historical checkpoint', () => {
  const now = '2026-10-31T00:00:00.000Z';
  const current = cbkListingSource(now);
  const selected = cbkSource(now);
  assert.notEqual(current.id, selected.id);
  assert.equal(current.region, 'africa');
  assert.equal(current.enabled, false);
  assert.match(current.name, /current circular listing/);
});

test('Bank of Ghana listing selects official draft directives and preserves unknown publication dates', async () => {
  const source = bogSource('2026-10-31T00:00:00.000Z');
  assert.equal(source.enabled, false);
  const official = 'https://www.bog.gov.gh/wp-content/uploads/2026/02/Guideline-on-ICAAP-clean.pdf';
  const html = `<html><body><a href="https://example.org/fake.pdf">Regulatory directive</a><a href="${official}">Guideline on Internal Capital Adequacy Assessment Process – Exposure Draft</a><a href="${official}">Download</a></body></html>`;
  const candidates = await bogAdapter.discover(source, { maxDocuments: 1 }, { async get(url) { return { bytes: Buffer.from(html), contentType: 'text/html', finalUrl: url }; } }, new AbortController().signal);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.downloadUrl, official);
  assert.equal(candidates[0]?.kind, 'consultation');
  assert.equal(candidates[0]?.publicationDate, null);
});

test('Bank of Ghana notices exclude procurement and follow one verified official PDF link', async () => {
  const source = bogNoticesSource('2026-10-31T00:00:00.000Z');
  assert.equal(source.enabled, true);
  const notice = 'https://www.bog.gov.gh/notice/notice-no-36-unlicensed-digital-credit-services-providers/';
  const pdf = 'https://www.bog.gov.gh/wp-content/uploads/2026/10/notice-36.pdf';
  const card = (title: string, url: string) => `<div class="elementor-column">October 6, 2026<h2 class="elementor-heading-title"><a href="${url}">${title}</a></h2></div>`;
  const html = `<html><body>${card('Notice – National Competitive Tendering', 'https://www.bog.gov.gh/notice/procurement/')}${card('Notice No. 36 – Unlicensed Digital Credit Services Providers', notice)}</body></html>`;
  const detail = `<html><body><a href="${pdf}">Download PDF</a></body></html>`;
  const candidates = await bogNoticesAdapter.discover(source, { maxDocuments: 1 }, { async get(url) { return { bytes: Buffer.from(url === source.url ? html : detail), contentType: 'text/html', finalUrl: url }; } }, new AbortController().signal);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.downloadUrl, pdf);
  assert.equal(candidates[0]?.publicationDate, '2026-10-06');
});

test('SAMA listing resolves canonical redirect and preserves verified metadata and section evidence', async () => {
  const source = samaSource('2026-10-31T00:00:00.000Z');
  const links = `<html><table class="circulars"><tbody><tr><td>482028988</td><td><a href="/en/node/11111">Security Council Resolution Circular</a></td><td>01/10/2026</td><td>20/04/1448</td><td>In-Force</td></tr></tbody></table></html>`;
  const fetcher = { async get(url: string) { return { bytes: Buffer.from(url === source.url ? links : samaDetail), contentType: 'text/html', finalUrl: url === source.url ? url : samaFinal }; } };
  const [candidate] = await samaAdapter.discover(source, { maxDocuments: 1 }, fetcher, new AbortController().signal);
  assert.equal(candidate?.referenceNumber, '482028988');
  assert.equal(candidate?.publicationDate, '2026-10-01');
  const routed = routeDocument(await fetcher.get(samaUrl), candidate!);
  assert.equal(routed.candidate.mediaType, 'text/html');
  assert.ok(routed.contentHash);
  const dir = await mkdtemp(join(tmpdir(), 'ria-sama-'));
  try {
    const path = join(dir, 'original.html');
    await writeFile(path, samaDetail);
    const extracted = await extractText(path, 'text/html', undefined, samaFinal);
    assert.ok(extracted.pages.some(page => page.locator?.includes('Requirements') && page.text.includes('screen customers')));
    assert.ok(!extracted.text.includes('Navigation must not enter'));
    assert.ok(!extracted.text.includes('window.evil'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('DFSA listing accepts regulatory notices and rejects unrelated news', async () => {
  const source = dfsaSource('2026-10-31T00:00:00.000Z');
  const news = listing(dfsaUrl).replace('</div></body>', '<a class="item" href="/news/media"><span class="tag">Media Release</span><span class="title">Other news</span></a></div></body>');
  const fetcher = { async get(url: string) { return { bytes: Buffer.from(url === source.url ? news : dfsaDetail), contentType: 'text/html', finalUrl: url }; } };
  const candidates = await dfsaAdapter.discover(source, { maxDocuments: 2 }, fetcher, new AbortController().signal);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, 'amendment');
  assert.equal(candidates[0]?.publicationDate, '2026-10-01');
  assert.equal(candidates[0]?.referenceNumber, null);
  assert.equal(routeDocument(await fetcher.get(dfsaUrl), candidates[0]!).candidate.mediaType, 'text/html');
});

test('official HTML extraction rejects challenge pages, landing pages and unsupported hosts', () => {
  const candidate = { title: 'Test', kind: 'circular' as const, canonicalKey: 'test', downloadUrl: samaUrl, mediaType: 'text/html' as const, referenceNumber: null, publicationDate: null, effectiveDate: null };
  for (const content of ['<html><body>Access denied</body></html>', '<html><body><div id="captcha">Challenge</div></body></html>', '<html><body>Welcome to the circular listing</body></html>']) {
    assert.throws(() => routeDocument({ bytes: Buffer.from(content), contentType: 'text/html', finalUrl: samaFinal }, candidate));
  }
  assert.throws(() => routeDocument({ bytes: Buffer.from(samaDetail), contentType: 'text/html', finalUrl: 'https://example.org/fake' }, candidate), /source-specific/);
});
