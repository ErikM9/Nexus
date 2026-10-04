import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    /* API route handlers run on the Node.js server runtime, so their tests use the node environment instead of jsdom */
    environmentMatchGlobs: [['tests/unit/api/**', 'node']],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        /* Generated shadcn/ui primitives */
        'src/components/ui/**',
        /* Page shells and the client bootstrap only wire components together, and the Playwright suite covers them end to end */
        'src/app/**/page.tsx',
        'src/app/layout.tsx',
        'src/app/client-init.tsx',
        'src/app/utils/ClientShell.tsx',
        '**/*.d.ts',
      ],
      /* A few points under the measured coverage, so a change that drops tests fails CI while ordinary refactoring does not */
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 78,
        functions: 72,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});