import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync } from 'node:fs';
import {
  startCustomerLinkService,
  installCustomerLinks,
} from './install-customer-links.mjs';
let service;
const checks = [];
export async function captureCustomerLinks(page, stage) {
  service ??= startCustomerLinkService();
  const server = await service;
  await server.reset();
  const base = new URL(page.url());
  base.pathname = base.pathname.replace(/\/app\/.*$/, '/app/');
  base.search = '';
  base.hash = '';
  if (stage.startsWith('owner-')) {
    await installCustomerLinks(page);
    const config = server.config();
    await page.evaluate(
      (v) => window.miseCustomerLinkTest.initialize(v),
      config,
    );
    const khata = stage === 'owner-khata';
    await page.goto(
      new URL(
        (khata
          ? 'khata/' + config.records.customer.id
          : 'orders/' + config.records.order.id) + '?flags=customerLinks',
        base,
      ).href,
    );
    const controls = page.getByRole('region', {
      name: khata ? 'Customer khata link' : 'Tracking link',
      exact: true,
    });
    await expect(
      controls.getByRole('button', {
        name: 'Create customer link',
        exact: true,
      }),
    ).toBeEnabled();
    if (stage === 'owner-recovery') server.loseNext('create_public_link');
    await controls
      .getByRole('button', { name: 'Create customer link', exact: true })
      .click();
    if (stage === 'owner-recovery') {
      await expect(
        controls.getByRole('button', {
          name: 'Close saved attempt',
          exact: true,
        }),
      ).toBeEnabled();
      await page.reload();
      await expect(
        controls.getByText(
          'The one-time link secret is unavailable here. Close this link before creating a replacement.',
          { exact: true },
        ),
      ).toBeVisible();
    } else
      await expect(
        controls.getByRole('textbox', {
          name: (khata ? 'Customer khata link' : 'Tracking link') + ' address',
        }),
      ).toHaveValue(/^http/);
  } else {
    const kind = stage === 'public-khata' ? 'khata' : 'order',
      cap = await server.issue(kind),
      url = new URL((kind === 'order' ? 't/' : 'k/') + cap.token, base);
    url.searchParams.set('flags', 'customerLinks');
    url.hash =
      'mise-customer=' +
      encodeURIComponent(
        JSON.stringify({ v: 1, apiUrl: server.config().apiUrl }),
      );
    if (stage === 'unavailable') await server.revoke(cap.id);
    if (stage === 'public-cancelled') await server.status('cancelled');
    await page.goto(url.href);
    if (stage === 'unavailable')
      await expect(
        page.getByRole('heading', {
          name: 'This link is unavailable. Ask the shop for a current link.',
          exact: true,
        }),
      ).toBeVisible();
    else {
      await expect(
        page.getByRole('link', { name: 'Call shop', exact: true }),
      ).toBeVisible();
      if (stage === 'public-bangla') {
        await page.getByRole('button', { name: 'বাংলা', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: 'ডেলিভারির পথে', exact: true }),
        ).toBeVisible();
      }
    }
  }
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  checks.push({
    stage,
    width: page.viewportSize().width,
    violations: result.violations.map((v) => ({ id: v.id, impact: v.impact })),
  });
  if (result.violations.length)
    throw Error(
      'Customer link accessibility check failed: ' +
        result.violations.map((v) => v.id).join(','),
    );
}
export async function closeCustomerLinksVisual() {
  try {
    if (service) await (await service).close();
  } finally {
    service = undefined;
    if (checks.length)
      writeFileSync(
        '.private/customer-links-visual-axe.json',
        JSON.stringify(checks, null, 2) + '\n',
      );
  }
}
