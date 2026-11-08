import { buildApp } from './app';
import { config } from './config';
import { pool } from './db';
import { migrate } from './migrate';

const app = await buildApp();
await migrate((m) => app.log.info(m));
await app.listen({ port: config.port, host: config.host });
app.log.info(`Streetkey server on ${config.publicUrl} (${config.env})`);

const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
