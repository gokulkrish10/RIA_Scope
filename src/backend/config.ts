import { resolve } from 'node:path';
import { z } from 'zod';

export function config() {
  const dataDir = resolve(process.env.RIA_DATA_DIR ?? '.data/ria');
  return {
    dataDir, databasePath: resolve(dataDir, 'ria.sqlite'), storagePath: resolve(dataDir, 'originals'),
    port: z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? '4010'),
    writeToken: z.string().min(32).parse(process.env.RIA_WRITE_TOKEN),
    scheduled: process.env.RIA_SCHEDULER_ENABLED === 'true',
  };
}
