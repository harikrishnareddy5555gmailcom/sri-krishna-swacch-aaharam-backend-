import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    exclude: ['test/*.e2e-spec.ts'],
    testTimeout: 15000,
  },
});
