import { defineConfig } from 'vitest/config';

// Server tests run against a real PostgreSQL database (DATABASE_URL_TEST), one file at a time.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? 'postgres://streetkey:streetkey@localhost:5432/streetkey_test',
      UPLOAD_DIR: 'server/.test-uploads',
      PUBLIC_URL: 'http://streetkey.test',
      SERVE_SITE: 'false',
      MODERATE_OWNER_LISTINGS: 'true',
      OPENAI_API_KEY: '',
      RESEND_API_KEY: '',
      AI_JOBS_MODE: 'sync',
      STORAGE_DRIVER: 'local',
    },
    setupFiles: ['server/test/setup.ts'],
  },
});
