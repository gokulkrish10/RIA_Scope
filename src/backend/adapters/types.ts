import { z } from 'zod';
import { DiscoveredPublicationSchema, DocumentMediaTypeSchema, PublicUrlSchema, type SourceConfig } from '../../shared/contracts/index.js';

// Internal adapter boundary, never a replacement for public shared response types.
export const CandidateSchema = DiscoveredPublicationSchema.pick({
  title: true, kind: true, referenceNumber: true, publicationDate: true, effectiveDate: true,
}).extend({ canonicalKey: z.string().min(1).max(2000), downloadUrl: PublicUrlSchema, mediaType: DocumentMediaTypeSchema });
export type Candidate = z.infer<typeof CandidateSchema>;
export interface Download { bytes: Buffer; contentType: string; finalUrl: string }
export interface OfficialFetcher { get(url: string, maxBytes: number, signal?: AbortSignal): Promise<Download> }
export interface SourceAdapter {
  readonly key: string;
  readonly allowedHosts: readonly string[];
  discover(source: SourceConfig, options: unknown, fetcher: OfficialFetcher, signal: AbortSignal): Promise<Candidate[]>;
}
export type AdapterRegistry = ReadonlyMap<string, SourceAdapter>;
