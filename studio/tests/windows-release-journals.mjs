import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [command, installed, jobs, fixtureRoot] = process.argv.slice(2);
const moduleUrl = name => pathToFileURL(path.join(installed, 'studio', 'dist', name + '.js')).href;
const [{ JobStore }, { StudioHost }] = await Promise.all([import(moduleUrl('job-store')), import(moduleUrl('studio-host'))]);
const source = path.join(fixtureRoot, 'source.raw');
const reference = path.join(fixtureRoot, 'reference.jpg');
const photos = new Map([1, 2].map(id => [id, {
  id, path: source, filename: 'source.raw', isVirtualCopy: false,
  developSettings: { Exposure2012: id, Saturation: 10 },
}]));
const plan = {
  title: 'Upgrade fixture',
  analysis: { target: 'light', reference: 'reference', adaptation: 'slightly softer', skin: 'none' },
  scalars: [{ key: 'Saturation', mode: 'delta', value: -5 }], curves: [], warnings: [],
};
let copyId = 10;
const lr = {
  async discover() { return ['Exposure2012', 'Saturation']; },
  async metadata(id) { return structuredClone(photos.get(Number(id))); },
  async preview(id) { return Buffer.from(JSON.stringify(photos.get(Number(id)).developSettings)); },
  async call(name, args) {
    if (name === 'create_virtual_copies') {
      const photoId = args.photo_ids[0], id = ++copyId;
      const copy = { ...structuredClone(photos.get(Number(photoId))), id, isVirtualCopy: true, virtualCopy: { masterPhotoId: photoId } };
      photos.set(id, copy);
      return { created: 1, copies: [{ copy_id: id, photo_id: photoId }] };
    }
    if (name === 'create_develop_snapshot') return { snapshot: { id: 'snapshot-' + args.photo_id } };
    if (name === 'set_develop_settings') {
      Object.assign(photos.get(Number(args.photo_id)).developSettings, args.settings);
      return { success: true };
    }
    throw new Error('Unexpected mock Lightroom action: ' + name);
  },
};
const host = new StudioHost(lr, { async generate() { return { plan: structuredClone(plan) }; } }, new JobStore(jobs), 0);
if (command === 'create') {
  await writeFile(source, 'synthetic RAW fixture');
  await writeFile(reference, Buffer.from([255, 216, 255, 19, 32]));
  const job = await host.capture({ mode: 'reference', prompt: 'soft', strength: 0.5, reference }, 1);
  await host.plan(job.id);
  await host.preview(job.id);
  const style = await host.saveStyle(job.id, 'Upgrade style');
  await host.batches.plan(style.id, ['1', '2'], undefined, new AbortController().signal, () => {});
}
assert.equal((await host.store.list()).length, 3);
assert.equal((await host.styles.list()).length, 1);
assert.equal((await host.batches.list()).length, 1);
