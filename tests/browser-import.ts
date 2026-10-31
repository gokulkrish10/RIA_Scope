// Compiled with DOM libraries and no Node ambient types by tsconfig.browser.json.
import { API_CONTRACT, JobStatusSchema, parsePublicationSearchParams, type JobStatus, type PaginatedResponse, type PublicationSummary } from '../src/shared/contracts/index.js';
import { publicationPageFixture } from '../src/shared/fixtures/index.js';

export const browserPage: PaginatedResponse<PublicationSummary> = publicationPageFixture;
export const browserQuery = parsePublicationSearchParams(new URLSearchParams('country=SA&page=1'));
export function parseJobInBrowser(data: unknown): JobStatus { return JobStatusSchema.parse(data); }
export const browserEndpoint = API_CONTRACT.searchPublications.path;
