import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: 'default',
  },
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@graph': r('./src/graph'),
      '@mcp': r('./src/mcp'),
      '@agent': r('./src/agent'),
      '@llm': r('./src/llm'),
      '@dataset': r('./src/dataset'),
      '@evaluator': r('./src/evaluator'),
      '@api': r('./src/api'),
    },
  },
});
