/**
 * ESLint 9 flat config.
 *
 * Migrated from `.eslintrc.json` (`{ "extends": ["next/core-web-vitals"] }`).
 * `eslint-config-next` is consumed through `FlatCompat` per the official
 * Next.js 15 migration guide.
 */
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...compat.extends('next/core-web-vitals'),
];

export default eslintConfig;
