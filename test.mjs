import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('real server: messaging, separate sessions, live replies, STOP, resume and CSRF', { timeout: 25000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'stockings-chat-test-'));
  const sessions = new Map();
  let count = 0;
  let interrupts = 0;
  let prompts = 0;
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://localhost');
    const answer = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('opencode:test-password').toString('base64')}`);
    if (url.pathname === '/api/session' && req.method === 'POST') {
      assert.equal(data.permissions[0].effect, 'deny');
      const id = `ses_mock${++count}`;
      sessions.set(id, []);
      return answer({ data: { id } });
    }
    const [, id, action] = url.pathname.match(/\/api\/session\/([^/]+)(?:\/([^/]+))?/) || [];
    if (!action) return answer({ data: {} });
    const messages = sessions.get(id);
    if (action === 'message') return answer({ data: [...messages].reverse() });
    if (action === 'interrupt') { interrupts++; return answer({ interrupted: true }); }
    if (action === 'prompt') {
      prompts++;
      assert.match(data.text, /Общая переписка/);
      const message = { id: `msg_${prompts}`, type: 'assistant', content: [{ type: 'text', text: `Ответ агента ${prompts}` }], time: { created: Date.now() }, finish: 'stop' };
      messages.push(message);
      setTimeout(() => { message.time.completed = Date.now(); }, 100);
      return answer({ data: {} });
    }
    res.writeHead(404).end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const registration = path.join(temp, 'service.json');
  await writeFile(registration, JSON.stringify({ url: `http://127.0.0.1:${mock.address().port}`, password: 'test-password' }));
  const port = 44000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: `${port}`, OPENCODE_SESSION_ID: '', OPENCODE_SERVICE_FILE: registration, CHAT_HISTORY_FILE: path.join(temp, 'history.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await new Promise(resolve => mock.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (data.toString().includes('Chat ready:')) resolve(); });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Server exit: ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const getState = () => fetch(`${base}/api/state`).then(r => r.json());
  const initial = await getState();
  const headers = { 'content-type': 'application/json', 'x-chat-token': initial.controlToken };
  const post = (route, data = {}, extra = {}) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  const waitFor = async predicate => {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      const value = await getState();
      if (predicate(value)) return value;
      await delay(80);
    }
    throw new Error('State condition timed out');
  };
  assert.equal(initial.status, 'paused');
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/api/start`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await post('start', {}, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await post('message', { text: ' ' })).status, 400);
  assert.equal((await post('message', { text: 'Подойдут ли матовые чулки?' })).status, 200);
  assert.equal((await post('message', { text: 'Привет от друга', senderID: 'guest-11111111-1111-4111-8111-111111111111', name: 'Аня' })).status, 200);
  const withGuest = await getState();
  assert.equal(withGuest.messages.at(-1).name, 'Аня');
  assert.match(withGuest.messages.at(-1).senderID, /^guest-/);
  assert.equal((await post('start')).status, 200);
  assert.equal((await post('start')).status, 409);
  const live = await waitFor(s => s.turns >= 3 && !!s.typing);
  assert.equal(count, 3);
  assert.deepEqual(new Set(live.messages.filter(m => ['sol','alice','mark'].includes(m.agent)).map(m => m.agent)), new Set(['sol','alice','mark']));
  assert.equal((await post('stop')).status, 200);
  const stopped = await getState();
  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.typing, null);
  const stoppedPrompts = prompts;
  await delay(850);
  assert.equal(prompts, stoppedPrompts, 'no prompt after STOP');
  assert.ok(interrupts > 0, 'STOP interrupts the active session');
  assert.equal((await post('start')).status, 200);
  await waitFor(s => s.turns > stopped.turns);
  await post('stop');
  const controller = new AbortController();
  const events = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const first = await events.body.getReader().read();
  assert.match(Buffer.from(first.value).toString(), /data: /);
  controller.abort();
});
