import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';

export default tseslint.config(
  { ignores: ['node_modules/**', 'site/**', '.private/**', '.secrets/**', '**/dist/**', '**/.astro/**', 'apps/web/public/ocr/**', 'handover/**', 'Claude outputs/**', 'mise-handover/**', 'playwright-report/**', 'test-results/**', 'qa/report.html'] },
  ...tseslint.configs.recommended,
  ...astro.configs['flat/recommended'],
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { files: ['**/*.astro'], languageOptions: { parserOptions: { parser: tseslint.parser } } },
);
