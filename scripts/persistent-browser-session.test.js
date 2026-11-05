import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { persistentBrowserSession } from '../services/persistent-browser-session.service.js';
function fakeContext() {
  const context = new EventEmitter();
  context.closed = 0;
  context.close = async () => { context.closed++; context.emit('close'); };
  return context;
}
test('login and workers share a context even during concurrent opens; close flushes it', async () => {
  let launches = 0;
  const session = persistentBrowserSession(async () => { launches++; return fakeContext(); });
  const [login, worker] = await Promise.all([session.get(), session.get()]);
  assert.equal(login, worker); assert.equal(launches, 1);
  assert.equal(await session.get(), login);
  await session.close(); assert.equal(login.closed, 1);
  const reopened = await session.get(); assert.notEqual(reopened, login); assert.equal(launches, 2);
  await session.close();
});
test('manual browser close releases the context and failed launch can be retried', async () => {
  let launches = 0;
  const session = persistentBrowserSession(async () => {
    if (++launches === 1) throw new Error('Profile in use');
    return fakeContext();
  });
  await assert.rejects(session.get(), /Profile in use/);
  const context = await session.get(); await context.close();
  assert.notEqual(await session.get(), context); assert.equal(launches, 3);
  await session.close();
});
