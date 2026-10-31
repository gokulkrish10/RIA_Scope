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
  const text = clean($('body').clone().find('script,style,noscript').remove().end().text());
  if (/captcha|access denied|verify (?:that )?you are human|human visitor|request blocked/i.test(text) || $('input[type="password"],[id*="captcha"],[class*="captcha"]').length) return [];
  return [...new Set($('a[href]').toArray().filter(a => /\.pdf(?:$|\?)/i.test($(a).attr('href') ?? '') && /download|document|circular|pdf/i.test($(a).text() + ($(a).attr('title') ?? '') + $(a).find('img').attr('alt'))).flatMap(a => {
    try { const url = new URL($(a).attr('href'), baseUrl); return url.protocol === 'https:' && allowedHosts.includes(url.hostname) && !url.username && !url.password ? [url.href] : []; } catch { return []; }
  }))];
}

function gregorianDate(value) {
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(value);
  const named = /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/.exec(value);
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const day = Number(numeric?.[1] ?? named?.[1]);
  const month = numeric ? Number(numeric[2]) : named ? months.indexOf(named[2].slice(0, 3).toLowerCase()) + 1 : 0;
  const year = Number(numeric?.[3] ?? named?.[3]);
  if (!day || !month || !year) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}
function verifiedBody($, body, label, title, referenceNumber, publicationDate) {
  body.find('script,style,noscript,nav,form,button,[hidden],[aria-hidden="true"]').remove();
  const pages = [{ pageNumber: null, locator: `${label} heading`, text: title }];
  let section = 'Body';
  for (const element of body.find('h2,h3,h4,p,li,tr').toArray().filter(element => !$(element).find('h2,h3,h4,p,li,tr').length)) {
    const content = $(element).clone();
    content.find('br').replaceWith(' ');
    if (element.tagName === 'tr') content.find('td,th').append(' | ');
    const value = clean(content.text());
    if (!value || value === title || value.length < 3) continue;
    if (/^h[2-4]$/.test(element.tagName)) section = value.slice(0, 100);
    pages.push({ pageNumber: null, locator: `${label} ${section}, block ${pages.length + 1}`, text: value });
  }
  const text = pages.map(page => page.text).join('\n\n');
  if (pages.length < 3 || text.length < 180 || text.length > 2_000_000 || pages.length > 300) throw new Error('HTML landing page or unsupported regulatory body; no verified document text.');
  const links = body.find('a[href]').toArray().map(element => ({ text: clean($(element).text()), href: $(element).attr('href') }));
  return { text, pages, title, referenceNumber, publicationDate, statusAssets: [], links };
}
export function officialRegulatoryHtml(html, sourceUrl) {
  const url = new URL(sourceUrl);
  if (['www.rbi.org.in', 'rbi.org.in'].includes(url.hostname) && /^\/Scripts\/NotificationUser.aspx$/i.test(url.pathname)) return regulatoryHtml(html);
  const $ = load(html);
  const raw = clean($('body').clone().find('script,style,noscript').remove().end().text());
  if ($('input[type="password"],iframe[src*="captcha"],[class*="captcha"],[id*="captcha"]').length || /access denied|verify (?:that )?you are human|request (?:has been )?blocked|checking your browser|complete the (?:security check|captcha)/i.test(raw)) throw new Error('Official site returned access-denied, login or challenge content; no extraction attempted.');
  // SAMA redirects listing node links to named canonical paths; the article structure
  // and numbered metadata are the verification boundary, not the URL slug.
  if (url.hostname === 'rulebook.sama.gov.sa' && /^\/en\/(?:node\/\d+|[a-z0-9-]+)\/?$/i.test(url.pathname)) {
    const article = $('article.node--type-book');
    const body = article.find('content .node__content').first();
    const title = clean(article.find('h2.page-title .field--name-title').first().text());
    const info = clean(article.find('table.info-table').first().text());
    const referenceNumber = /\bNo:\s*([A-Za-z0-9/-]+)/i.exec(info)?.[1] ?? null;
    if (!body.length || !title || !referenceNumber || !/\bDate\(g\):/i.test(info)) throw new Error('HTML landing page or unsupported SAMA circular body.');
    return verifiedBody($, body, 'SAMA circular', title, referenceNumber, gregorianDate(/Date\(g\):\s*([^|]+)/i.exec(info)?.[1] ?? ''));
  }
  if (url.hostname === 'www.dfsa.ae' && /^\/news\/notice-(?:amendments?-legislation|consultation-paper)/i.test(url.pathname)) {
    const article = $('.news-content-wrap .info-block-wrap').first();
    const body = article.find('.animation-hidden.fade-up.delay-800').first();
    const title = clean(article.find('h1').first().text());
    if (!body.length || !/^Notice of (?:Amendments? to Legislation|Consultation Paper)/i.test(title)) throw new Error('HTML landing page or unsupported DFSA notice body.');
    return verifiedBody($, body, 'DFSA notice', title, null, gregorianDate(article.find('h6.date').first().text()));
  }
  throw new Error('HTML needs a verified source-specific regulatory body extractor; select a verified official document link.');
}
