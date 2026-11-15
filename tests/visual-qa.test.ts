import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

test('visual differences preserve extra height and normalise retina references without stretching', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import sharp from 'sharp';
    import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    import {compareImages} from './scripts/visual-diff.mjs';
    const directory=mkdtempSync(join(tmpdir(),'mise-visual-'));
    const files=['actual.png','retina.png','taller.png'].map(name=>join(directory,name));
    try {
      await sharp({create:{width:20,height:10,channels:3,background:'#fff'}}).png().toFile(files[0]);
      await sharp({create:{width:40,height:20,channels:3,background:'#fff'}}).png().toFile(files[1]);
      await sharp({create:{width:20,height:20,channels:3,background:'#000'}}).composite([{input:files[0],top:0,left:0}]).png().toFile(files[2]);
      const same=await compareImages(files[0],files[1]);
      const extra=await compareImages(files[0],files[2]);
      console.log(JSON.stringify({same:same.metrics,extra:extra.metrics}));
    } finally {for(const file of files)unlinkSync(file);rmdirSync(directory);}
  `], { encoding: 'utf8' });
  const { same, extra } = JSON.parse(result);
  expect(same.percent).toBe(0);
  expect(same.comparisonReference).toEqual({ width: 20, height: 10 });
  expect(extra.canvas).toEqual({ width: 20, height: 20 });
  expect(extra.percent).toBe(50);
});
