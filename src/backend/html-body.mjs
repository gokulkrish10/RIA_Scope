import { load } from 'cheerio';

const clean = value => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// Deliberately source-specific selectors. An arbitrary HTML page is not regulatory evidence.
export function regulatoryHtml(html) {
  const $ = load(html);
  $('script,style,noscript,nav,header,footer,form input,button,[hidden],[aria-hidden="true"]').remove();
  const visible = clean($('body').text());
  if ($('input[type="password"],iframe[src*="captcha"],[class*="captcha"],[id*="captcha"]').length ||
      /access denied|verify (?:that )?you are human|request (?:has been )?blocked|enable javascript and cookies|checking your browser|complete the (?:security check|captcha)/i.test(visible) ||
      /^(?:login|sign in|just a moment|access denied|attention required)/i.test(clean($('title').text()))) {
    throw new Error('Official site returned access-denied, login or challenge content; no extraction attempted.');
  }
  const body = $('#NotificationUser #doublescroll').first();
  if (!body.length) throw new Error('HTML landing page or unsupported regulatory body; select a verified official document link.');
  const title = clean(body.find('td.tableheader b').first().text());
  const referenceBody = body.clone(); referenceBody.find('br').replaceWith(' '); referenceBody.find('p,td,th').append(' ');
  const referenceNumber = clean(referenceBody.text()).match(/\b(?:DOR|DoR|DBR|DNBR)[A-Za-z0-9.() -]*\/\d[\w./-]+\/\d{4}-\d{2}\b/)?.[0] ?? null;
  if (!title || !referenceNumber || body.text().length < 400) throw new Error('HTML contains no verified RBI regulatory body.');
  const dates = body.find('p[align="right"]').toArray().map(p => clean($(p).text()));
  let publicationDate = null;
  for (const value of dates) {
    if (!/^[A-Za-z]+ \d{1,2}, \d{4}$/.test(value)) continue;
    const parsed = new Date(value + ' 00:00:00 UTC');
    if (!Number.isNaN(parsed.valueOf())) { publicationDate = parsed.toISOString().slice(0, 10); break; }
  }
  const pages = [];
  const statusAssets = [...new Set(body.find('[style]').toArray().flatMap(e => [...($(e).attr('style') ?? '').matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)].map(m => m[1])).filter(url => /withdrawn|repealed|superseded/i.test(url)))];
  // This is explicitly an asset observation, not invented text or an inferred effective date.
  for (const asset of statusAssets) pages.push({ pageNumber: null, locator: 'RBI HTML status watermark asset', text: `Source HTML status watermark asset: ${asset}` });
  pages.push({ pageNumber: null, locator: 'RBI HTML document heading', text: title });
  let section = 'Preamble';
  // Leaf paragraphs + table rows without paragraphs preserve text in DOM order without double counting nested tables.
  const elements = body.find('p,tr').toArray().filter(e => e.tagName === 'p' || !$(e).find('p,tr').length);
  for (const e of elements) {
    const node = $(e).clone();
    node.find('br').replaceWith(' ');
    if (e.tagName === 'tr') node.find('td,th').append(' | ');
    const text = clean(node.text());
    if (!text || text === title || /^\(?\d+ kb\)?$/i.test(text)) continue;
    const anchor = $(e).find('[id]').first().attr('id');
    const number = /^(\d+(?:\.\d+)*\.)\s/.exec(text)?.[1];
    if (anchor) section = `Anchor ${anchor}`;
    else if (number && e.tagName !== 'tr') section = `Clause ${number}`;
    else if (/^(?:Repeal|Applicability and Commencement|Exemptions|Annex\b)/i.test(text) && text.length < 100) section = text;
    pages.push({ pageNumber: null, locator: `RBI HTML ${section}${e.tagName === 'tr' ? `, table row ${number ?? 'unnumbered'}` : ''}, block ${pages.length + 1}`, text });
  }
  const text = pages.map(p => p.text).join('\n\n');
  if (pages.length < 4 || pages.length > 300 || text.length > 2_000_000) throw new Error('Regulatory HTML text is missing or exceeds extraction limits.');
  // Include link targets in the deduplication key: a changed official reference is material even if its label is unchanged.
  const links = body.find('a[href]').toArray().map(a => ({ text: clean($(a).text()), href: $(a).attr('href') }));
  return { text, pages, title, referenceNumber, publicationDate, statusAssets, links };
}

export function officialDocumentLinks(html, baseUrl, allowedHosts) {
  const $ = load(html);
  // Link selection only, never follow login/challenge pages or guess a document URL.
  const text = clean($('body').text());
  if (/captcha|access denied|verify (?:that )?you are human|human visitor|request blocked/i.test(text) || $('input[type="password"],[id*="captcha"],[class*="captcha"]').length) return [];
  return [...new Set($('a[href]').toArray().filter(a => /\.pdf(?:$|\?)/i.test($(a).attr('href') ?? '') && /download|document|circular|pdf/i.test($(a).text() + ($(a).attr('title') ?? '') + $(a).find('img').attr('alt'))).flatMap(a => {
    try { const url = new URL($(a).attr('href'), baseUrl); return url.protocol === 'https:' && allowedHosts.includes(url.hostname) && !url.username && !url.password ? [url.href] : []; } catch { return []; }
  }))];
}
