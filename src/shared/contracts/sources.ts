import { z } from 'zod';
import { CountryCodeSchema, IdSchema, NonEmptyTextSchema, PublicUrlSchema, RegionSchema, UtcTimestampSchema, paginatedResponseSchema } from './common.js';

export const MonitoringIntervalSchema = z.number().int().min(15).max(43_200);
export const SourceConfigSchema = z.strictObject({
  id: IdSchema,
  name: NonEmptyTextSchema.max(200),
  country: CountryCodeSchema,
  region: RegionSchema,
  regulatorId: IdSchema,
  regulatorName: NonEmptyTextSchema.max(200),
  url: PublicUrlSchema,
  enabled: z.boolean(),
  monitoringIntervalMinutes: MonitoringIntervalSchema,
  lastMonitoredAt: UtcTimestampSchema.nullable(),
  nextMonitorAt: UtcTimestampSchema.nullable(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).superRefine((s, ctx) => {
  const fixedCountries = { ksa: 'SA', uae: 'AE', india: 'IN' };
  if (s.region !== 'africa' && s.country !== fixedCountries[s.region]) ctx.addIssue({ code: 'custom', path: ['country'], message: 'Country must match region' });
  if (!s.enabled && s.nextMonitorAt !== null) ctx.addIssue({ code: 'custom', path: ['nextMonitorAt'], message: 'Disabled sources cannot be scheduled' });
});
export const SourceUpdateRequestSchema = z.strictObject({
  name: NonEmptyTextSchema.max(200).optional(),
  url: PublicUrlSchema.optional(),
  enabled: z.boolean().optional(),
  monitoringIntervalMinutes: MonitoringIntervalSchema.optional(),
}).refine(v => Object.values(v).some(value => value !== undefined), 'Supply at least one field');
export const SourceListResponseSchema = paginatedResponseSchema(SourceConfigSchema);
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type SourceUpdateRequest = z.infer<typeof SourceUpdateRequestSchema>;
