import { buildApp } from './app';
import { config } from './config';
import { pool } from './db';
import { migrate } from './migrate';
import { sweep } from './ai/jobs';

const app = await buildApp();
await migrate((m) => app.log.info(m));
await app.listen({ port: config.port, host: config.host });
app.log.info(`Streetkey server on ${config.publicUrl} (${config.env})`);

// A failed background promise must never take the whole server down.
process.on('unhandledRejection', (e) => app.log.error({ err: e }, 'unhandled rejection'));
// AI jobs run in this process: recover any that were interrupted (deploy, crash) and keep checking.
if (config.jobs.mode === 'inline') {
  const recover = () => { sweep().catch((e) => app.log.warn({ err: (e as Error).message }, 'job sweep failed')); };
  setTimeout(recover, 5_000).unref();
  setInterval(recover, 60_000).unref();
}

const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
