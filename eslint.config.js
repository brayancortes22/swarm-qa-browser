import js from '@eslint/js';
import globals from 'globals';

const unusedVars = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }];

export default [
  { ignores: ['node_modules/', '**/overlay.bundle.js', '.agents/', '.specify/', '.qa/', '.swarm/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': unusedVars, 'no-empty': ['error', { allowEmptyCatch: true }], 'no-control-regex': 'off' }
  },
  {
    files: ['packages/overlay/**/*.js', 'packages/demo/**/*.js'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['packages/extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly' } }
  },
  {
    // Playwright page callbacks run in the browser.
    files: ['test/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, __swarmDemo: 'readonly', chrome: 'readonly' } }
  },
  {
    files: ['packages/extension/content.js', 'packages/demo/public/demo.js'],
    languageOptions: { sourceType: 'script' }
  }
];
