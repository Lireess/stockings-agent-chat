import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway } from './share-gateway.mjs';

test('public gateway: private invitation, named guests, CSRF, rate limit, no AI controls or upstream credentials', async t => {
  const received = [];
  const ownerToken = 'PRIVATE_OWNER_CSRF_MUST_NOT_ESCAPE';
  const secret = 'a-long-random-invitation-for-tests';
  let clock = 100000;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/state') return res.end(JSON.stringify({ messages: [{ agent: 'user', text: 'private history' }], controlToken: ownerToken, canControl: true }));
    if (req.url === '/api/message') {
      assert.equal(req.headers['x-chat-token'], ownerToken);
      assert.equal(req.headers.origin, `http://127.0.0.1:${upstream.address().port}`);
      received.push(JSON.parse(raw));
      return res.end('{"ok":true}');
    }
    res.writeHead(404).end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const gateway = createGateway({ inviteCode: secret, upstream: `http://127.0.0.1:${upstream.address().port}`, now: () => clock });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(async () => {
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]);
  });
  const host = 'my-friends.trycloudflare.com';
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: gateway.address().port, path: url, method, headers: { host, ...(method === 'POST' ? { origin: `https://${host}`, 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const publicRoot = await request('/');
  assert.match(publicRoot.text, /Вас ждут в чате/);
  assert.doesNotMatch(publicRoot.text, /private history/);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/events')).status, 401);
  assert.equal((await request('/api/join', { method: 'POST', body: { code: 'wrong', name: 'Аня' } })).status, 403);
  assert.equal((await request('/api/join', { method: 'POST', headers: { origin: 'https://evil.invalid' }, body: { code: secret, name: 'Аня' } })).status, 403);
  const joined = await request('/api/join', { method: 'POST', body: { code: secret, name: 'Аня' } });
  assert.equal(joined.status, 200);
  const setCookie = joined.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];
  const guestState = await request('/api/state', { headers: { cookie } });
  const state = guestState.json();
  assert.equal(state.viewerName, 'Аня');
  assert.equal(state.canControl, false);
  assert.equal(state.polling, true);
  assert.notEqual(state.controlToken, ownerToken);
  assert.doesNotMatch(guestState.text, new RegExp(ownerToken));
  const guestHeaders = { cookie, 'x-chat-token': state.controlToken };
  for (const endpoint of ['/api/start', '/api/stop', '/api/session', '/conversation.json', '/share-private.json', '/share-link.txt', '/server.mjs']) {
    assert.equal((await request(endpoint, { method: 'POST', headers: guestHeaders, body: {} })).status, 403);
  }
  assert.equal((await request('/api/message', { method: 'POST', headers: { cookie }, body: { text: 'hi' } })).status, 403);
  assert.equal((await request('/api/message', { method: 'POST', headers: { ...guestHeaders, origin: 'https://evil.invalid' }, body: { text: 'hi' } })).status, 403);
  const sent = await request('/api/message', { method: 'POST', headers: guestHeaders, body: { text: '<script>hi</script>', senderID: 'owner', name: 'Владелец' } });
  assert.equal(sent.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].name, 'Аня', 'client cannot forge the author');
  assert.match(received[0].senderID, /^guest-/);
  assert.equal(received[0].text, '<script>hi</script>');
  assert.equal((await request('/api/message', { method: 'POST', headers: guestHeaders, body: { text: 'spam' } })).status, 429);
  clock += 21600001;
  assert.equal((await request('/api/state', { headers: { cookie } })).status, 401);
  const rejoin = await request('/api/join', { method: 'POST', body: { code: secret, name: 'Боря' } });
  const freshCookie = rejoin.headers['set-cookie'][0].split(';')[0];
  const freshState = (await request('/api/state', { headers: { cookie: freshCookie } })).json();
  assert.notEqual(freshState.viewerID, state.viewerID, 'different visitors get different identities');
  const logout = await request('/api/logout', { method: 'POST', headers: { cookie: freshCookie, 'x-chat-token': freshState.controlToken }, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await request('/api/state', { headers: { cookie: freshCookie } })).status, 401);
});
