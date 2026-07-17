import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isShellAsset, simulateSwCache, SHELL_ASSET_PREFIX } from '../app/lib/qualify/m/swCachePolicy.js';

test('only same-path GET build assets are cacheable', () => {
  assert.equal(SHELL_ASSET_PREFIX, '/_next/static/');
  assert.equal(isShellAsset('/_next/static/chunks/main-abc.js', 'GET'), true);
  assert.equal(isShellAsset('/_next/static/css/app.css', 'GET'), true);
  assert.equal(isShellAsset('/_next/static/chunks/main-abc.js', 'POST'), false); // never cache a POST
  assert.equal(isShellAsset('/qualify/m', 'GET'), false); // dynamic page HTML (can carry rendered data)
  assert.equal(isShellAsset('/qualify/m/manifest.webmanifest', 'GET'), false);
  assert.equal(isShellAsset('/qualify/m/sw.js', 'GET'), false);
});

test('SW cache stays free of PHI/dollar responses after a full search->list->swipe->detail flow', () => {
  // Server Actions are POSTs to the page route carrying PHI (member ids, names, group #) and dollar
  // amounts; only /_next/static chunks are shell assets, so nothing sensitive is ever eligible.
  const flow = [
    { pathname: '/qualify/m', method: 'GET', body: '<html>app shell</html>' },
    { pathname: '/_next/static/chunks/app-1.js', method: 'GET', body: 'console.log("chunk")' },
    { pathname: '/_next/static/css/app.css', method: 'GET', body: '.row{}' },
    // getQualifySnapshot — PHI + dollars in the response
    { pathname: '/qualify/m', method: 'POST', body: JSON.stringify({ cases: [{ member: 'AETMEMBER123', name: 'DOE, JANE', group: 'GRP9', billed: 18400, allowed: 11592 }] }) },
    // getQualifyMovers
    { pathname: '/qualify/m', method: 'POST', body: JSON.stringify({ movers: [{ payer: 'AETNA', cases: 40 }] }) },
    // a hypothetical reveal — raw PHI
    { pathname: '/qualify/m', method: 'POST', body: JSON.stringify({ member_id_raw: 'AETMEMBER123', group_number: 'GRP9' }) },
    { pathname: '/qualify/m/manifest.webmanifest', method: 'GET', body: '{"name":"Lead lookup"}' },
  ];
  const { cachedPaths, cachedBodies } = simulateSwCache(flow);

  assert.deepEqual(cachedPaths.sort(), ['/_next/static/chunks/app-1.js', '/_next/static/css/app.css']);
  const blob = cachedBodies.join('\n');
  for (const sentinel of ['AETMEMBER123', 'DOE, JANE', 'GRP9', 'member_id_raw', 'group_number', '18400', '11592', 'AETNA']) {
    assert.ok(!blob.includes(sentinel), `SW cache must never contain "${sentinel}"`);
  }
});
