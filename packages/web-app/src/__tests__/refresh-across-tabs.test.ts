import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake server with rotation: only the newest cookie is valid, and each tab's request
// reads the shared browser cookie when it starts, as a real browser does.
let cookie = '';
let issued = 0;
const statuses: number[] = [];
const respond = (status: number, body: object) => ({ok: status < 400, status, json: async () => body});

async function refreshEndpoint() {
  const presented = cookie;
  await new Promise(resolve => setTimeout(resolve, 5));
  if (presented !== `token-${issued}`) { statuses.push(401); return respond(401, {error: 'Invalid refresh token'}); }
  issued += 1;
  cookie = `token-${issued}`;
  statuses.push(200);
  return respond(200, {accessToken: `access-${issued}`});
}

// Each tab runs its own copy of the module, so tabs share only the cookie and the lock.
async function openTab() {
  vi.resetModules();
  return import('../lib/api');
}

// Minimal Web Locks: callers holding the same name run one at a time.
function fakeLocks() {
  const queues = new Map<string, Promise<unknown>>();
  return {request: (name: string, callback: () => Promise<unknown>) => {
    const run = (queues.get(name) ?? Promise.resolve()).then(callback, callback);
    queues.set(name, run.catch(() => {}));
    return run;
  }};
}

beforeEach(() => {
  cookie = 'token-0'; issued = 0; statuses.length = 0;
  vi.stubGlobal('fetch', vi.fn(refreshEndpoint));
  vi.stubGlobal('navigator', {locks: fakeLocks()});
});
afterEach(() => vi.unstubAllGlobals());

describe('refreshing from several tabs', () => {
  it('lets two tabs restoring at once both stay signed in', async () => {
    const [tabA, tabB] = [await openTab(), await openTab()];
    expect(await Promise.all([tabA.restoreSession(), tabB.restoreSession()])).toEqual([true, true]);
    expect(statuses).toEqual([200, 200]);
    expect(tabA.getAccessToken()).toBeTruthy();
    expect(tabB.getAccessToken()).toBeTruthy();
  });

  it('still refreshes in browsers without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const tab = await openTab();
    expect(await tab.restoreSession()).toBe(true);
    expect(statuses).toEqual([200]);
  });
});
