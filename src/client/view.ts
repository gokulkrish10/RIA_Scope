import type { SourceEvidence } from '../shared/contracts/index.js';
export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const label = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase());
export const date = (value: string | null) => !value ? 'Unknown' : value.length === 10 ? value : new Date(value).toLocaleString();
export const badge = (value: string) => `<span class="badge ${escape(value)}">${escape(label(value))}</span>`;
export const evidence = (value: SourceEvidence | null, other?: SourceEvidence | null) => {
  if (!value) return '<p class="muted">No previous obligation · new requirement</p>';
  const words = new Set(other?.excerpt.split(/\s+/) ?? []);
  const excerpt = value.excerpt.split(/(\s+)/).map(word => other && word.trim() && !words.has(word) ? `<mark>${escape(word)}</mark>` : escape(word)).join('');
  return `<blockquote>${excerpt}</blockquote><details><summary>${escape(value.locator)}${value.pageNumber ? ` · page ${value.pageNumber}` : ''} · evidence</summary><p class="mono">Document ${escape(value.documentId)}<br>Version ${escape(value.versionId)}</p></details>`;
};
