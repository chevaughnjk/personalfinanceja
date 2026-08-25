import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

const PROVEN_MODEL_FILES = [
  'application/analysis/goals.js',
  'application/analysis/commitment-income.js',
  'application/analysis/committed-flexible.js',
  'application/analysis/position.js',
  'application/analysis/forecast.js',
  'application/analysis/forecast-accuracy.js',
  'application/analysis/available-now.js',
  'application/analysis/category-intentions.js',
  'application/analysis/tag-totals.js',
  'application/analysis/transaction-splits.js',
  'application/analysis/custom-categories.js',
  'application/analysis/spendable-categories.js',
  'application/analysis/goal-migrate.js',
  'application/analysis/treemap-layout.js',
];

export default defineConfig([
  {
    ignores: [
      'third-party/**',
      'launcher/logs/**',
      'interface/archive/**',
      '**/*.min.js',
      '**/*.min.mjs',
      'node_modules/**',
    ],
  },

  {
    files: ['**/*.{js,mjs}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-unused-expressions': ['error', { allowShortCircuit: false, allowTernary: false }],
      'no-unreachable': 'error',
      'no-duplicate-imports': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],

      'no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      'no-shadow': 'warn',
      'no-redeclare': 'error',

      'max-depth': ['warn', 7],
      complexity: ['warn', 70],
    },
  },

  {
    files: ['application/**/*.js', 'interface/**/*.js', 'settings/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        indexedDB: 'readonly',
        IDBKeyRange: 'readonly',
      },
    },
  },

  {
    files: ['application/analysis/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    files: PROVEN_MODEL_FILES,
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'document',
          message:
            'Proven-model modules must be DOM-free (proofs import them in Node). Keep DOM in ui/.',
        },
        { name: 'window', message: 'Proven-model modules must be DOM-free. Keep DOM in ui/.' },
        {
          name: 'localStorage',
          message:
            'Proven-model modules must be storage-free. Persist via core/storage.js from the app layer.',
        },
        {
          name: 'navigator',
          message:
            'Proven-model modules must be environment-free. Keep browser APIs in ui/ or app.js.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/reporting.js', '**/bank-analysis.js'],
              message:
                'Proven-model modules must not import the legacy analysis lineage (reporting.js / bank-analysis.js). Port the small pure helper you need locally, as G did with projectCardPayoff.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['application/ui/**/*.js', 'application/analysis/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='bootUI']",
          message:
            'bootUI() belongs only in app.js. This looks like a lossy-paste fragment leaked into a module.',
        },
        {
          selector: "MemberExpression[object.name='window'][property.name='__pfaBoot']",
          message:
            'window.__pfaBoot is app.js boot plumbing. It should never appear in a render or analysis module.',
        },
        {
          selector:
            "CallExpression[callee.property.name='addEventListener'][arguments.0.value='DOMContentLoaded']",
          message:
            'DOMContentLoaded wiring belongs in app.js, not a module. Likely a paste fragment.',
        },
      ],
    },
  },

  {
    files: ['application/output/history-codec.js'],
    languageOptions: {
      globals: { ...globals.browser, Buffer: 'readonly' },
    },
  },

  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'max-depth': 'off',
      complexity: 'off',
    },
  },

  {
    files: ['developer-tools/**/*.js', 'helpers/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['service-worker.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },

  {
    files: ['desktop-app/**/*.cjs', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
]);
