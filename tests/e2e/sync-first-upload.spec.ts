import { expect, test } from '@playwright/test';
import { startConvergenceServer } from '../sync-convergence-server';
import { installRealtimeFixture } from '../realtime-browser-fixture';
// @ts-expect-error The isolated native installer is JavaScript, not shipped code.
import { installSyncApplyFixture } from '../fixtures/install-sync-apply.mjs';

test('the actual 5,000-record local shop resumes a lost promotion reply with its original review and then syncs offline cash', async ({
  page,
}) => {
  test.setTimeout(180000);
  const server = await startConvergenceServer({
    emptyCloud: true,
    records: 5000,
  });
  try {
    await installRealtimeFixture(page, server.config(1).jwt);
    await page.goto('app/');
    await installSyncApplyFixture(page);
    await page.evaluate(
      (config) => window.miseSyncApplyTest.initializeLocal(config),
      server.config(1),
    );
    await page.goto('app/settings/sync?flags=cloudSync');
    await page
      .getByRole('button', { name: 'Prepare local review', exact: true })
      .click();
    await expect(page.getByText('5,000 records', { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await installSyncApplyFixture(page);
    const original = await page.evaluate(() =>
      window.miseSyncApplyTest.review(),
    );
    expect(original.snapshot?.manifest.records).toBe(5000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: 50000,
      uploadThroughput: 50000,
      connectionType: 'cellular3g',
    });
    server.loseNextUploadFinish();
    const started = Date.now();
    await page
      .getByRole('button', { name: 'Turn on sync', exact: true })
      .click();
    await expect(
      page.getByText(
        'Sync could not finish. Keep your local records, check your account and saved review, then try again.',
        { exact: true },
      ),
    ).toBeVisible({ timeout: 90000 });
    const uploadMs = Date.now() - started;
    expect(uploadMs).toBeLessThan(60000);
    expect(await server.promotedUploads()).toBe(1);
    const failed = await page.evaluate(() =>
        window.miseSyncApplyTest.inspect(),
      ),
      review = await page.evaluate(() => window.miseSyncApplyTest.review());
    expect(failed.binding?.phase).toBe('uploading');
    expect(failed.binding?.uploadId).toBe(original.snapshot?.id);
    expect({ ...review.snapshot, progress: null }).toEqual(original.snapshot);
    expect(review.snapshot?.progress?.received).toEqual(
      original.snapshot?.manifest.chunks.map((part) => part.index),
    );
    await page
      .getByRole('button', { name: 'Resume upload', exact: true })
      .click();
    await expect(
      page.getByText(
        'Upload receipt saved. Later local changes remain in the change queue.',
        { exact: true },
      ),
    ).toBeVisible({ timeout: 30000 });
    await cdp.detach();
    await expect(
      page.getByRole('link', { name: 'Sync: Synced', exact: true }),
    ).toBeVisible({ timeout: 90000 });
    expect(await server.promotedUploads()).toBe(1);
    const completed = await page.evaluate(() =>
      window.miseSyncApplyTest.inspect(),
    );
    expect(completed.binding?.uploadId).toBe(original.snapshot?.id);
    expect(completed.binding?.phase).toBe('ready');
    expect(completed.base).toBeDefined();
    expect(completed.imageSizes).toEqual(failed.imageSizes);
    await page.context().setOffline(true);
    await page.evaluate(() => window.miseSyncApplyTest.cash('59'));
    await expect(
      page.getByRole('link', { name: /^Sync: Offline, 1 unsent/ }),
    ).toBeVisible();
    const pending = await page.evaluate(() =>
      window.miseSyncApplyTest.inspect(),
    );
    const profiler =
      process.env.MISE_SYNC_PROFILE === '1'
        ? await page.context().newCDPSession(page)
        : null;
    if (profiler) {
      await profiler.send('Profiler.enable');
      await profiler.send('Profiler.start');
    }
    await page.context().setOffline(false);
    try {
      await expect(
        page.getByRole('link', { name: 'Sync: Synced', exact: true }),
      ).toBeVisible({ timeout: 45000 });
    } finally {
      if (profiler) {
        const result = await profiler.send('Profiler.stop');
        await test.info().attach('sync-recovery-profile.json', {
          body: JSON.stringify(result.profile),
          contentType: 'application/json',
        });
        await profiler.detach();
      }
    }
    const after = await page.evaluate(() => window.miseSyncApplyTest.inspect());
    expect(after.queue[0].commands).toEqual(pending.queue[0].commands);
    expect(after.queue[0].status).toBe('accepted');
    expect(
      await server.financialCount([
        after.queue[0].changes.find((c) => c.table === 'sales')!.key,
      ]),
    ).toBe(1);
    await test.info().attach('local-upload-timing.json', {
      body: JSON.stringify({
        records: 5000,
        uploadMs,
        network: {
          latencyMs: 400,
          downloadBytesPerSecond: 50000,
          uploadBytesPerSecond: 50000,
        },
        syntheticAuthAndStorage: true,
        genuineHostedAcceptance: false,
      }),
      contentType: 'application/json',
    });
  } catch (error) {
    const status = await page
      .evaluate(() => window.miseSyncApplyTest.cycleInspect())
      .catch(() => null);
    await test.info().attach('sync-recovery-diagnostic.json', {
      body: JSON.stringify({
        status,
        calls: server.calls,
        diagnostics: server.diagnostics,
      }),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await page.context().setOffline(false);
    await server.close();
  }
});
