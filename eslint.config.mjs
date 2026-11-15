import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';

export default tseslint.config(
  { ignores: ['node_modules/**', 'site/**', '**/dist/**', '**/.astro/**', 'handover/**', 'Claude outputs/**', 'mise-handover/**', 'playwright-report/**', 'test-results/**'] },
  ...tseslint.configs.recommended,
  ...astro.configs['flat/recommended'],
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { files: ['**/*.astro'], languageOptions: { parserOptions: { parser: tseslint.parser } } },
);
