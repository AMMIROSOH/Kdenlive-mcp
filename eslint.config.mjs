import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/artifacts/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ['packages/*/src/**/*.ts'],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ['packages/*/src/**/*.ts'],
  })),
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./packages/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
