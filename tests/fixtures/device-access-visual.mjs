import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { startDeviceUiService, installDeviceUi } from './install-device-ui.mjs';
let service;
const accessibility = [];
export async function captureDeviceAccess(page, stage) {
  service ??= startDeviceUiService();
  const server = await service;
  await server.reset();
  const appBase = new URL('./', page.url());
  if (stage === 'owner') {
    await installDeviceUi(page);
    await page.evaluate(
      (config) => window.miseDeviceUiTest.initialize(config),
      server.config(),
    );
    await page.goto(
      new URL('settings/devices?flags=deviceAccess', appBase).href,
    );
    await page.getByRole('button', { name: 'Create pairing code' }).waitFor();
    await page.getByRole('button', { name: 'Create pairing code' }).click();
    await page.getByLabel('Pairing code', { exact: true }).waitFor();
    await page.getByAltText('Setup QR for this shared screen').waitFor();
  } else {
    const pairing = await server.newPairing(),
      config = server.config(),
      url = new URL('screen/setup?flags=deviceAccess', appBase);
    url.hash =
      'mise-screen=' +
      encodeURIComponent(
        JSON.stringify({
          v: 1,
          connection: {
            apiUrl: config.apiUrl,
            publishableKey: config.publishableKey,
          },
          pairingId: pairing.id,
          code: pairing.code,
        }),
      );
    await page.goto(url.href);
    await page.getByRole('button', { name: 'Request pairing' }).waitFor();
    if (stage !== 'setup') {
      await page.getByRole('button', { name: 'Request pairing' }).click();
      await page.getByLabel('Screen verification').waitFor();
      if (stage === 'signin' || stage === 'recovery') {
        // Poll the resolved native read, then compare the exact original receipt.
        // An async waitForFunction predicate can stop on its truthy Promise.
        let receipt;
        await expect
          .poll(async () => {
            receipt = await page.evaluate(async () => {
              const db = await new Promise((resolve, reject) => {
                const r = indexedDB.open(
                  'mise.screen.v1:' +
                    location.pathname.replace(/\/app\/.*$/, '/app/'),
                );
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
              });
              try {
                return await new Promise((resolve) => {
                  const r = db
                    .transaction('state')
                    .objectStore('state')
                    .get('current');
                  r.onsuccess = () => {
                    const state = r.result?.state;
                    resolve(
                      state?.receipt
                        ? {
                            id: state.source.requestId,
                            verification: state.receipt.verification,
                          }
                        : false,
                    );
                  };
                });
              } finally {
                db.close();
              }
            });
            return Boolean(receipt);
          })
          .toBe(true);
        const rendered = (
          await page.getByLabel('Screen verification').textContent()
        )?.trim();
        if (rendered !== receipt.verification) {
          throw Error(
            'Rendered fixture verification must match the original native receipt.',
          );
        }
        await server.approvePending(pairing.id, rendered, receipt.id);
        await page
          .getByRole('combobox', { name: 'Your name', exact: true })
          .waitFor();
        if (stage === 'recovery') {
          server.loseNext('pin');
          await page
            .getByRole('combobox', { name: 'Your name', exact: true })
            .selectOption({ label: 'Member 105' });
          await page.getByLabel('Four-digit PIN', { exact: true }).fill('0042');
          await page
            .getByRole('button', { name: 'Sign in', exact: true })
            .click();
          await page
            .getByRole('heading', { name: 'Recover the previous sign-in' })
            .waitFor();
        }
      }
    }
  }
  const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze(),
    serious = axe.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
  accessibility.push({
    stage,
    width: page.viewportSize().width,
    violations: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      targets: v.nodes.map((node) => ({
        target: node.target,
        reason: node.failureSummary,
      })),
    })),
    serious: serious.length,
  });
  if (serious.length)
    throw Error(
      'Shared-screen accessibility check failed: ' +
        serious.map((v) => v.id).join(', '),
    );
}
export async function closeDeviceAccessVisual() {
  if (service) {
    await (await service).close();
    service = undefined;
  }
  if (accessibility.length) {
    mkdirSync('.private', { recursive: true });
    writeFileSync(
      '.private/device-access-visual-axe.json',
      JSON.stringify(accessibility, null, 2) + '\n',
    );
  }
}
