import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canExportXmp, exportStyleXmp } from '../dist/xmp-preset.js';

const style = {
  id: '00000000-0000-0000-0000-000000000004',
  name: '海岸 & <薄雾>',
  intent: 'Private source description',
  referenceFile: 'reference.jpg',
  sourceBaseline: { Shadows2012: 5, GrainAmount: 7 },
  sourceSettings: {
    Exposure2012: 0.7, Temperature: 6200, Tint: 20, WhiteBalance: 'Custom', CameraProfile: 'Adobe Color',
    ProcessVersion: '15.4', CropAngle: 2, RedHue: 4, Shadows2012: 12, HueAdjustmentBlue: -4,
    SplitToningHighlightSaturation: 5, GrainAmount: 7, ToneCurvePV2012: [0, 4, 127, 128, 255, 250],
  },
};

async function outputDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lr-studio-xmp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('writes only changed portable settings and escapes names without embedding style context', async t => {
  const directory = await outputDir(t);
  const output = path.join(directory, '海岸.xmp');
  assert.equal(canExportXmp(style), true);
  const result = await exportStyleXmp(style, output);
  assert.deepEqual(result.keys, ['HueAdjustmentBlue', 'Shadows2012', 'SplitToningHighlightSaturation', 'ToneCurvePV2012']);
  const xml = await readFile(result.path, 'utf8');
  assert.match(xml, /crs:UUID="[A-F0-9]{32}"/);
  assert.match(xml, /海岸 &amp; &lt;薄雾&gt;/);
  assert.match(xml, /crs:Shadows2012="12"/);
  assert.match(xml, /crs:ToneCurveName2012="Custom"/);
  assert.match(xml, /<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 4<\/rdf:li><rdf:li>127, 128<\/rdf:li><rdf:li>255, 250<\/rdf:li>/);
  assert.doesNotMatch(xml, /Exposure2012|Temperature|\bTint\b|WhiteBalance|CameraProfile|ProcessVersion|CropAngle|RedHue|GrainAmount|Private source|reference\.jpg/);
  const second = await exportStyleXmp(style, path.join(directory, 'same-style.xmp'));
  assert.equal(await readFile(second.path, 'utf8'), xml);
});

test('refuses empty or malformed portable settings before publishing a file', async t => {
  const directory = await outputDir(t);
  const output = path.join(directory, 'preset.xmp');
  for (const [sourceSettings, error] of [
    [undefined, /没有可导出的/],
    [{ Exposure2012: 0.7 }, /没有可导出的/],
    [{ Shadows2012: 110 }, /参数无效/],
    [{ ToneCurvePV2012: [0, 20, 255, 5] }, /Curve/],
  ]) {
    const candidate = { ...style, sourceSettings };
    assert.equal(canExportXmp(candidate), false);
    await assert.rejects(exportStyleXmp(candidate, output), error);
  }
  assert.deepEqual(await readdir(directory), []);
});

test('guards photo-sidecar names and publishes to a new XMP path only once', async t => {
  const directory = await outputDir(t);
  await writeFile(path.join(directory, 'DSC_0001.NEF'), 'photo');
  for (const name of ['dsc_0001.xmp', 'dsc_0001.nef.XMP']) {
    await assert.rejects(exportStyleXmp(style, path.join(directory, name)), /照片匹配/);
  }
  await assert.rejects(exportStyleXmp(style, path.join(directory, 'bad.xml')), /\.xmp 文件路径/);
  const occupied = path.join(directory, 'existing.xmp');
  await writeFile(occupied, 'original');
  await assert.rejects(exportStyleXmp(style, occupied), /文件已存在/);
  assert.equal(await readFile(occupied, 'utf8'), 'original');

  const output = path.join(directory, 'race.xmp');
  const results = await Promise.allSettled([exportStyleXmp(style, output), exportStyleXmp(style, output)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /文件已存在/);
  assert.deepEqual((await readdir(directory)).sort(), ['DSC_0001.NEF', 'existing.xmp', 'race.xmp']);
});
