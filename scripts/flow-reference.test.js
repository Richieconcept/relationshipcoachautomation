import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowReferenceSession, referenceAsset } from '../services/flow-reference.service.js';

function browserPage() {
  return { url: () => 'https://flow.example/project/1', isClosed: () => false };
}

function library() {
  const files = new Set();
  const calls = { uploads: 0, selections: 0 };
  let attached = false;
  return {
    calls, files,
    detach() { attached = false; },
    operations: {
      isAttached: async () => attached,
      clearAttachments: async () => { attached = false; },
      selectExisting: async name => {
        calls.selections++;
        if (!files.has(name)) return false;
        attached = true;
        return true;
      },
      upload: async asset => { calls.uploads++; files.add(asset.name); attached = true; }
    }
  };
}

test('later scenes retain or reattach the storyboard without another upload', async () => {
  const session = new FlowReferenceSession(), page = browserPage(), lib = library();
  const asset = { name: 'storyboard-a.png' };
  assert.equal(await session.ensure(page, asset, lib.operations), 'uploaded');
  assert.equal(await session.ensure(page, asset, lib.operations), 'attached');
  lib.detach();
  assert.equal(await session.ensure(page, asset, lib.operations), 'reused');
  assert.equal(lib.calls.uploads, 1);
  assert.equal(session.canReuseProject(page), true);
});

test('a new account uploads independently; replacing the image selects a new asset', async () => {
  const session = new FlowReferenceSession(), page = browserPage(), first = library(), second = library();
  await session.ensure(page, { name: 'old.png' }, first.operations);
  assert.equal(await session.ensure(browserPage(), { name: 'old.png' }, second.operations), 'uploaded');
  assert.equal(await session.ensure(page, { name: 'new.png' }, first.operations), 'uploaded');
  assert.equal(first.calls.uploads, 2);
});

test('restart reuses an existing asset and navigation invalidates project state', async () => {
  const page = browserPage(), lib = library(), asset = { name: 'saved.png' };
  await new FlowReferenceSession().ensure(page, asset, lib.operations);
  lib.detach();
  const restarted = new FlowReferenceSession();
  assert.equal(await restarted.ensure(page, asset, lib.operations), 'reused');
  page.url = () => 'https://flow.example/project/2';
  assert.equal(restarted.canReuseProject(page), false);
  assert.equal(lib.calls.uploads, 1);
});

test('a failed upload is never remembered as a successful attachment', async () => {
  const session = new FlowReferenceSession(), page = browserPage(), lib = library();
  await assert.rejects(session.ensure(page, { name: 'missing.png' }, {
    ...lib.operations, upload: async () => { throw new Error('upload failed'); }
  }), /upload failed/);
  assert.equal(await session.ensure(page, { name: 'missing.png' }, lib.operations), 'uploaded');
});

test('the same image at different paths has the same content identity', async () => {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('../tmp/reference-test-', import.meta.url)));
  try {
    const a = path.join(directory, 'presenter.jpg'), b = path.join(directory, 'other.jpg');
    await fs.writeFile(a, 'image bytes');
    await fs.copyFile(a, b);
    const first = await referenceAsset(a), second = await referenceAsset(b);
    assert.equal(first.name, second.name);
    await fs.writeFile(a, 'replacement image');
    assert.notEqual((await referenceAsset(a)).name, first.name);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
