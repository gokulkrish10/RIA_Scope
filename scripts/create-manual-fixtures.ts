import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';

// Local, synthetic upload inputs only. No network, model, or database access.
const directory = resolve('.data/manual-fixtures');
await mkdir(directory, { recursive: true, mode: 0o700 });
const save = async (name: string, bytes: string | Uint8Array) => {
  const path = resolve(directory, name);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (existing.equals(Buffer.from(bytes))) return;
    if (name.endsWith('.docx')) {
      const current = unzipSync(existing);
      const expected = unzipSync(Buffer.from(bytes));
      if (Object.keys(current).length === Object.keys(expected).length &&
          Object.keys(expected).every(key => {
            const actualFile = current[key], expectedFile = expected[key];
            return actualFile !== undefined && expectedFile !== undefined && Buffer.from(actualFile).equals(Buffer.from(expectedFile));
          })) return;
    }
    throw error;
  }
};

const pdfText = 'SYNTHETIC TEST ONLY. Banks must maintain records.';
const stream = `BT /F1 12 Tf 72 720 Td (${pdfText}) Tj ET`;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

const docx = zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'word/document.xml': strToU8('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>SYNTHETIC TEST ONLY. Banks must retain validation reports.</w:t></w:r></w:p></w:body></w:document>'),
});

await save('manual-upload.pdf', pdf);
await save('manual-upload.docx', docx);
await save('manual-upload.txt', 'SYNTHETIC TEST ONLY. Banks must review controls annually.\n');
await save('unreadable.pdf', '%PDF-1.4\nSYNTHETIC TEST ONLY. This is deliberately unreadable.\n');
await save('unsupported.html', '<!doctype html><title>SYNTHETIC TEST ONLY</title>');
await save('version-v1.txt', 'SYNTHETIC TEST ONLY. Banks must review controls annually.\n');
await save('version-v2.txt', 'SYNTHETIC TEST ONLY. Banks must review controls quarterly.\n');
console.log(`Seven synthetic files ready in ${directory}`);
