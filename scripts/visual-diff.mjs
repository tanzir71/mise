import sharp from 'sharp';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

// Preserve aspect ratio and unmatched height; never stretch or trim away a difference.
export async function compareImages(actualPath, referencePath, clip) {
  const actual = await sharp(actualPath).flatten({ background: '#fff' }).png().toBuffer();
  const actualMeta = await sharp(actual).metadata();
  const original = await sharp(referencePath).metadata();
  let referenceImage = sharp(referencePath);
  if (clip) referenceImage = referenceImage.extract(clip);
  const reference = await referenceImage.resize({ width: actualMeta.width }).flatten({ background: '#fff' }).png().toBuffer();
  const referenceMeta = await sharp(reference).metadata();
  const width = actualMeta.width;
  const height = Math.max(actualMeta.height, referenceMeta.height);
  const pad = async (buffer, currentHeight) => PNG.sync.read(await sharp(buffer).extend({ top: 0, left: 0, right: 0, bottom: height - currentHeight, background: '#fff' }).png().toBuffer());
  const a = await pad(actual, actualMeta.height);
  const b = await pad(reference, referenceMeta.height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1, includeAA: false });
  return { reference, diff: PNG.sync.write(diff), metrics: {
    changed, total: width * height, percent: Number((100 * changed / (width * height)).toFixed(2)),
    actual: { width, height: actualMeta.height }, original: { width: original.width, height: original.height },
    comparisonReference: { width, height: referenceMeta.height }, canvas: { width, height }, clip: clip || null,
  } };
}
