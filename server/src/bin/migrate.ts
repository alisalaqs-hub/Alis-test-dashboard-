import { pool } from '../db';
import { migrate } from '../migrate';

migrate((m) => console.log(m)).then(() => { console.log('migrations up to date'); return pool.end(); }).catch((e) => { console.error(e.message); process.exit(1); });
