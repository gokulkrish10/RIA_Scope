export interface RegulatoryHtml {
  text: string;
  pages: { pageNumber: null; locator: string; text: string }[];
  title: string; referenceNumber: string | null; publicationDate: string | null;
  statusAssets: string[]; links: { text: string; href: string }[];
}
export function regulatoryHtml(html: string): RegulatoryHtml;
export function officialRegulatoryHtml(html: string, sourceUrl: string): RegulatoryHtml;
export function officialDocumentLinks(html: string, baseUrl: string, allowedHosts: readonly string[]): string[];
