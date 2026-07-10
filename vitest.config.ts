import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['scripts/check-*.js'],
    exclude: ['node_modules', 'dist', 'evals', 'scripts/check-node-version.js'],
  },
  resolve: {
    conditions: ['node'],
  },
});
