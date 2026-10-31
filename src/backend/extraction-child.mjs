// Runs in a separate process: bounded heap, wall-clock and output, no inherited credentials.
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { load } from 'cheerio';
import { regulatoryHtml } from './html-body.mjs';

const [filePath, mediaType] = process.argv.slice(2);
const bytes = await readFile(filePath);
const maxText = 2_000_000;
let pages = [];
let imageOnly = false;
process.on('uncaughtException', error => {
  const code = error.message === 'PDF has images but no text layer' ? 'imageOnlyPdf'
    : /access-denied, login or challenge/.test(error.message) ? 'accessContent'
    : /HTML landing page|no verified RBI/.test(error.message) ? 'unverifiedHtml'
    : error.message === 'No readable text or text limit exceeded' ? 'noReadableText'
    : error.name === 'PasswordException' ? 'encryptedPdf' : 'invalidOrOverLimit';
  process.stderr.write(`RIA_EXTRACTION_ERROR:${code}\n`);
  process.exit(1);
});
if (mediaType === 'application/pdf') {
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid PDF');
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const document = await task.promise;
  try {
    if (document.numPages > 300) throw new Error('Page limit exceeded');
    let length = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      length += text.length;
      if (!text) {
        const operators = await page.getOperatorList();
        imageOnly ||= operators.fnArray.some(op => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op));
      }
      if (length > maxText) throw new Error('Text limit exceeded');
      pages.push({ pageNumber, text });
      page.cleanup();
    }
  } finally { await task.destroy(); }
} else if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
  let expanded = 0;
  let entries = 0;
  const files = unzipSync(bytes, { filter: entry => {
    expanded += entry.originalSize;
    if (++entries > 2000 || expanded > 40 * 1024 * 1024) throw new Error('Expanded DOCX limit exceeded');
    return ['[Content_Types].xml', 'word/document.xml'].includes(entry.name);
  } });
  if (!files['[Content_Types].xml'] || !files['word/document.xml']) throw new Error('Invalid DOCX');
  const xml = strFromU8(files['word/document.xml']);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported XML declaration');
  const $ = load(xml, { xmlMode: true });
  const text = $('w\\:p').toArray().map(p => $(p).find('w\\:t').text()).join('\n').trim();
  pages = [{ pageNumber: null, text }];
} else if (mediaType === 'text/html') {
  pages = regulatoryHtml(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).pages;
} else if (mediaType === 'text/plain') {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').trim();
  if (text.includes('\u0000')) throw new Error('Binary text document');
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error('HTML must use the verified regulatory HTML route');
  pages = [{ pageNumber: null, text }];
} else throw new Error('Unsupported media type');
const text = pages.map(page => page.text).join('\n\n').trim();
if (!text && imageOnly) throw new Error('PDF has images but no text layer');
if (!text || text.length > maxText) throw new Error('No readable text or text limit exceeded');
process.stdout.write(JSON.stringify({ text, pages }));
