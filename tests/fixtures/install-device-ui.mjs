import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let bundle;
async function vite() {
  const path = createRequire(resolve('package.json')).resolve('vite', {
    paths: [resolve('apps/web')],
  });
  return import(pathToFileURL(path).href);
}
export async function startDeviceUiService() {
  const { build } = await vite(),
    built = await build({
      configFile: false,
      root: process.cwd(),
      logLevel: 'silent',
      resolve: { alias: { '@mise/core': resolve('packages/core') } },
      build: {
        ssr: 'tests/fixtures/device-ui-service.ts',
        write: false,
        minify: false,
        rollupOptions: { external: ['@electric-sql/pglite'] },
      },
    }),
    output = Array.isArray(built) ? built[0].output : built.output,
    chunk = output.find((item) => item.type === 'chunk');
  if (!chunk || output.filter((item) => item.type === 'chunk').length !== 1)
    throw Error('Expected one synthetic screen service');
  mkdirSync('.private', { recursive: true });
  const file = resolve('.private/device-ui-service-' + process.pid + '.mjs');
  writeFileSync(file, chunk.code);
  return (
    await import(pathToFileURL(file).href + '?start=' + Date.now())
  ).startDeviceUiService();
}
export async function installDeviceUi(page) {
  bundle ??= (async () => {
    const { build } = await vite(),
      built = await build({
        configFile: false,
        root: process.cwd(),
        logLevel: 'silent',
        resolve: { alias: { '@mise/core': resolve('packages/core') } },
        build: {
          write: false,
          minify: false,
          lib: {
            entry: resolve('tests/fixtures/device-ui-browser.ts'),
            formats: ['iife'],
            name: 'MiseDeviceUiTest',
          },
          rollupOptions: { output: { inlineDynamicImports: true } },
        },
      }),
      output = Array.isArray(built) ? built[0].output : built.output,
      chunk = output.find((item) => item.type === 'chunk');
    if (!chunk || output.filter((item) => item.type === 'chunk').length !== 1)
      throw Error('Expected one isolated screen initializer');
    return chunk.code;
  })();
  const script = await bundle,
    url = new URL('__mise_device_ui_test.js', page.url()).href;
  await page.route(url, (route) =>
    route.fulfill({
      contentType: 'text/javascript; charset=utf-8',
      body: script,
    }),
  );
  await page.addScriptTag({ url });
}
