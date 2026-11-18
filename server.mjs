import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4317);
const agents = [
  { id: 'sol', name: 'Сол', role: 'Ведущий', initials: 'С', color: 'purple',
    instruction: 'Ты Сол, ведущий дружеского чата. Сравнивай варианты чулок по ситуации, задавай участникам конкретные вопросы и помогай прийти к полезному выводу. Не подводи итог в каждом сообщении.' },
  { id: 'alice', name: 'Алиса', role: 'Стилист', initials: 'А', color: 'pink',
    instruction: 'Ты Алиса, стилист. Обсуждай сочетания чулок с одеждой и обувью: оттенок, матовость, плотность DEN, уместность. Вежливо спорь, предлагай конкретные образы без рекламы брендов.' },
  { id: 'mark', name: 'Марк', role: 'Эксперт по комфорту', initials: 'М', color: 'teal',
    instruction: 'Ты Марк, эксперт по повседневному комфорту. Сравнивай размер, материалы, сезон, посадку, силиконовую резинку и пояс. Учитывай чувствительность кожи. Не назначай медицинскую компрессию: это вопрос к врачу.' },
];
const state = {
  status: 'paused', typing: null, messages: [], turns: 0,
  maxTurns: 60, error: null, agents: agents.map(({ instruction, ...a }) => a),
  topic: 'Какие чулки лучше надевать: на каждый день, на вечер и в прохладную погоду?',
};
const clients = new Set();
let revision = 0;
let runID = 0;
let runningTask = null;
let activeSession = null;
let sessions = {};
let closing = false;
let lastGuestPoll = 0;
const controlToken = randomUUID();
const historyFile = process.env.CHAT_HISTORY_FILE || path.join(root, 'conversation.json');

// Only this app's conversation is persisted. OpenCode credentials never leave the server.
try {
  const saved = JSON.parse(await readFile(historyFile, 'utf8'));
  if (Array.isArray(saved.messages)) state.messages = saved.messages.slice(-500);
} catch {}
let saveChain = Promise.resolve();
function persist() {
  const json = JSON.stringify({ messages: state.messages }, null, 2);
  saveChain = saveChain.then(() => writeFile(historyFile, json, 'utf8')).catch(console.error);
}
function publish() {
  const payload = `id: ${++revision}\ndata: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) client.write(payload);
}
function message(agent, text, extra = {}) {
  const result = { id: randomUUID(), agent, text, time: Date.now(), ...extra };
  state.messages.push(result);
  state.messages = state.messages.slice(-500);
  publish();
  persist();
  return result;
}
async function api(route, body, options = {}) {
  // Read the current registration each time, including after an OpenCode restart.
  const serviceFile = process.env.OPENCODE_SERVICE_FILE ||
    path.join(homedir(), '.local', 'state', 'opencode', 'service.json');
  const service = JSON.parse(await readFile(serviceFile, 'utf8'));
  const endpoint = new URL(service.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Ожидался локальный сервис OpenCode.');
  }
  const response = await fetch(new URL(route, endpoint), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(options.timeout || 15000),
  });
  if (!response.ok) {
    // Do not send raw provider errors or credentials to the browser.
    throw new Error(`OpenCode вернул HTTP ${response.status}. Проверьте доступность модели в OpenCode.`);
  }
  return response.json();
}
function current(id) { return id === runID && state.status === 'running'; }
async function interrupt(sessionID) {
  if (sessionID) await api(`/api/session/${sessionID}/interrupt`, {}).catch(console.error);
}
async function ensureSessions(id) {
  // Follow the model already chosen by the user in the launching OpenCode session,
  // rather than silently falling back to a different global default.
  let model;
  if (process.env.OPENCODE_SESSION_ID) {
    const source = await api(`/api/session/${process.env.OPENCODE_SESSION_ID}`);
    model = source.data.model;
  }
  for (const agent of agents) {
    if (!current(id)) return;
    if (!sessions[agent.id]) {
      const result = await api('/api/session', {
        title: `Чулки · ${agent.name}`,
        location: { directory: root },
        ...(model ? { model } : {}),
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      });
      sessions[agent.id] = result.data.id;
    }
  }
}
function buildPrompt(agent) {
  const context = state.messages.filter(m => m.agent !== 'system' && !m.partial)
    .slice(-24).map(m => `${m.agent === 'user' ? m.name || 'Владелец' : agents.find(a => a.id === m.agent)?.name || m.agent}: ${m.text}`).join('\n');
  return `${agent.instruction}
Ты отдельный ИИ-участник группового чата о выборе чулок. Отвечай только от своего лица, по-русски, 1–3 короткими предложениями, до 85 слов. Никаких подписей, заголовков, ролевых ремарок или markdown. Не используй инструменты, не создавай файлы или других агентов. Обсуждай одежду практично, без сексуального содержания. Не заявляй, что что-то лично носил. Не повторяй уже сказанное: ответь на последнюю реплику, добавь аргумент или вопрос другому участнику. Последняя просьба пользователя важнее общей темы. После ответа остановись и жди следующего сообщения.
Тема: ${state.topic}
Общая переписка:
${context || 'Обсуждение только начинается. Предложи первый конкретный вариант и спроси мнение коллег.'}
Теперь одна реплика участника ${agent.name}:`;
}
async function turn(agent, id) {
  const sessionID = sessions[agent.id];
  state.typing = agent.id;
  publish();
  const before = await api(`/api/session/${sessionID}/message?limit=20&order=desc`);
  if (!current(id)) return;
  const seen = new Set(before.data.map(m => m.id));
  activeSession = sessionID;
  try {
    await api(`/api/session/${sessionID}/prompt`, { text: buildPrompt(agent) }, { timeout: 30000 });
    // STOP can arrive while a prompt is being accepted. Interrupt again after acceptance.
    if (!current(id)) { await interrupt(sessionID); return; }
    const deadline = Date.now() + 150000;
    let bubble = null;
    while (current(id)) {
      const result = await api(`/api/session/${sessionID}/message?limit=20&order=desc`);
      if (!current(id)) break;
      const replies = result.data.filter(m => m.type === 'assistant' && !seen.has(m.id)).reverse();
      const text = replies.flatMap(m => m.content.filter(p => p.type === 'text').map(p => p.text)).join('\n').trim();
      if (text) {
        if (!bubble) bubble = message(agent.id, text, { partial: true });
        else if (bubble.text !== text) { bubble.text = text; publish(); }
      }
      const latest = replies.at(-1);
      if (latest?.error) {
        if (latest.error.type === 'provider.free-limit' || latest.error.status === 429) {
          throw new Error('Достигнут лимит модели OpenCode. Проверьте доступные лимиты или выберите другую модель в OpenCode и перезапустите чат.');
        }
        throw new Error('Модель не смогла ответить. Проверьте подключение и лимиты в OpenCode.');
      }
      if (latest?.time.completed && latest.finish !== 'tool-calls') {
        if (!text) throw new Error('Модель вернула пустой ответ. Попробуйте продолжить разговор.');
        bubble.partial = false;
        state.turns++;
        state.typing = null;
        publish();
        persist();
        return;
      }
      if (Date.now() > deadline) {
        await interrupt(sessionID);
        throw new Error('Агент не ответил за 150 секунд. Разговор приостановлен.');
      }
      await delay(650);
    }
  } finally {
    if (activeSession === sessionID) activeSession = null;
    for (const m of state.messages) if (m.partial) { m.partial = false; m.interrupted = true; }
    persist();
  }
}
async function conversation(id) {
  try {
    await ensureSessions(id);
    while (current(id) && state.turns < state.maxTurns) {
      await turn(agents[state.turns % agents.length], id);
      // A bounded, cancellable interval keeps the conversation readable.
      for (let i = 0; i < 18 && current(id); i++) await delay(150);
    }
    if (current(id)) {
      state.status = 'paused';
      state.typing = null;
      message('system', 'Достигнут лимит 60 ответов. Нажмите «Продолжить», если хотите ещё.');
    }
  } catch (error) {
    if (current(id)) {
      await interrupt(activeSession);
      state.status = 'paused';
      state.typing = null;
      state.error = error.message;
      message('system', error.message);
    }
  } finally { publish(); }
}
async function stop(reason = 'Разговор остановлен. Можно продолжить в любой момент.') {
  if (state.status !== 'running' && state.status !== 'stopping') return;
  state.status = 'stopping';
  state.typing = null;
  ++runID;
  publish();
  await interrupt(activeSession);
  await runningTask;
  state.status = 'paused';
  message('system', reason);
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 20000) throw new Error('Слишком длинное сообщение.');
  }
  return text ? JSON.parse(text) : {};
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const send = (code, value) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  try {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host)) return send(403, { error: 'Недопустимый адрес.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (req.headers['x-chat-observer'] === controlToken) lastGuestPoll = Date.now();
      return send(200, { ...state, controlToken, viewerID: 'owner', viewerName: 'Владелец', canControl: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-chat-token'] !== controlToken ||
          (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin))) {
        return send(403, { error: 'Запрос разрешён только из локального чата.' });
      }
      const data = await body(req);
      if (url.pathname === '/api/start') {
        if (state.status !== 'paused') return send(409, { error: 'Разговор уже запущен или ещё останавливается.' });
        if (closing) return send(503, { error: 'Сервер завершает работу.' });
        state.error = null;
        state.status = 'running';
        if (state.turns >= state.maxTurns) state.turns = 0;
        const id = ++runID;
        message('system', 'Агенты подключаются к обсуждению…');
        runningTask = conversation(id);
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/stop') { await stop(); return send(200, { ok: true }); }
      if (url.pathname === '/api/message') {
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > 2000) return send(400, { error: 'Введите сообщение длиной от 1 до 2000 символов.' });
        const guest = typeof data.senderID === 'string' && /^guest-[a-f0-9-]{36}$/.test(data.senderID);
        const name = guest && typeof data.name === 'string' ? data.name.trim().slice(0, 32) : 'Владелец';
        message('user', text, { senderID: guest ? data.senderID : 'owner', name: name || 'Друг' });
        return send(200, { ok: true });
      }
      return send(404, { error: 'Не найдено.' });
    }
    if (req.method === 'GET') {
      const files = { '/': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js', '/favicon.svg': 'favicon.svg' };
      const file = files[url.pathname];
      if (!file) return send(404, { error: 'Не найдено.' });
      const content = await readFile(path.join(root, 'public', file));
      res.writeHead(200, { 'content-type': `${mime[path.extname(file)]}; charset=utf-8`, 'cache-control': 'no-cache' });
      return res.end(content);
    }
    send(405, { error: 'Метод не поддерживается.' });
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) send(500, { error: 'Не удалось выполнить запрос. Проверьте, что OpenCode запущен.' });
    else res.end();
  }
});
// No open page means no unattended model spending.
let absentSince = null;
setInterval(() => {
  const observed = clients.size || Date.now() - lastGuestPoll < 15000;
  if (observed) absentSince = null;
  else if (!absentSince) absentSince = Date.now();
  if (!observed && absentSince && Date.now() - absentSince > 45000 && state.status === 'running') {
    void stop('Чат закрыт: агенты автоматически остановлены.');
  }
}, 5000).unref();
async function shutdown() {
  if (closing) return;
  closing = true;
  await stop('Сервер чата выключен.');
  await saveChain;
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.listen(port, '127.0.0.1', () => console.log(`Chat ready: http://127.0.0.1:${port}`));
