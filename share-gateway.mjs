import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest();
const random = () => randomBytes(24).toString('base64url');
export function createGateway({ inviteCode, upstream = 'http://127.0.0.1:4317', publicHost = '', now = Date.now }) {
  if (!inviteCode || inviteCode.length < 16) throw new Error('Use a strong random invitation code.');
  if (new URL(upstream).hostname !== '127.0.0.1') throw new Error('Only loopback upstream is allowed.');
  const inviteHash = hash(inviteCode);
  const sessions = new Map();
  const attempts = new Map();
  let upstreamToken = '';
  const staticFiles = { '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/join.js': ['join.js', 'text/javascript'] };
  const getState = async () => {
    const response = await fetch(`${upstream}/api/state`, {
      headers: upstreamToken ? { 'x-chat-observer': upstreamToken } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Backend unavailable');
    const state = await response.json();
    upstreamToken = state.controlToken;
    return state;
  };
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const file = async (name, type) => {
      const bytes = await readFile(path.join(root, 'public', name));
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      res.end(bytes);
    };
    const readBody = async () => {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 12000) throw new Error('Request too large');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    };
    try {
      const host = req.headers.host || '';
      const local = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
      // A configured stable hostname or the temporary Cloudflare hostname, never arbitrary hosts.
      if (!local && host !== publicHost && !/^[a-z0-9-]+\.trycloudflare\.com$/.test(host)) return json(403, { error: 'Недопустимый адрес.' });
      const origin = `${local ? 'http' : 'https'}://${host}`;
      const url = new URL(req.url, origin);
      if (req.method === 'POST' && req.headers.origin !== origin) return json(403, { error: 'Неверный источник запроса.' });
      const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('chat_guest='))?.slice(11);
      let session = sessions.get(cookie);
      if (session && session.expires <= now()) { sessions.delete(cookie); session = null; }
      if (req.method === 'POST' && url.pathname === '/api/join') {
        const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress).slice(0, 100);
        for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
        const record = attempts.get(ip) || { count: 0, until: now() + 600000 };
        if (record.count >= 15 || attempts.size > 2000) return json(429, { error: 'Слишком много попыток. Попробуйте через 10 минут.' });
        record.count++;
        attempts.set(ip, record);
        const data = await readBody();
        const code = typeof data.code === 'string' ? data.code : '';
        if (!timingSafeEqual(hash(code), inviteHash)) return json(403, { error: 'Неверный код приглашения.' });
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) return json(400, { error: 'Введите имя от 1 до 32 символов.' });
        for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
        if (sessions.size >= 100) return json(429, { error: 'Достигнут лимит участников.' });
        const key = random();
        session = { id: `guest-${randomUUID()}`, name, csrf: random(), expires: now() + 21600000, sent: [], lastSent: 0 };
        sessions.set(key, session);
        res.setHeader('Set-Cookie', `chat_guest=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=21600${local ? '' : '; Secure'}`);
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        // Login assets are public; app code is not a secret and contains no keys.
        return file(...staticFiles[url.pathname]);
      }
      if (req.method === 'GET' && url.pathname === '/') return file(session ? 'index.html' : 'join.html', 'text/html');
      if (!session) return json(401, { error: 'Войдите по приглашению.' });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const data = await getState();
        return json(200, { ...data, controlToken: session.csrf, viewerID: session.id, viewerName: session.name, canControl: false, polling: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        if (req.headers['x-chat-token'] !== session.csrf) return json(403, { error: 'Обновите страницу.' });
        sessions.delete(cookie);
        res.setHeader('Set-Cookie', `chat_guest=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${local ? '' : '; Secure'}`);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/message') {
        if (req.headers['x-chat-token'] !== session.csrf) return json(403, { error: 'Обновите страницу и повторите отправку.' });
        session.sent = session.sent.filter(time => now() - time < 60000);
        if (now() - session.lastSent < 1000 || session.sent.length >= 30) return json(429, { error: 'Слишком часто. Подождите немного.' });
        const data = await readBody();
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > 2000) return json(400, { error: 'Сообщение должно содержать от 1 до 2000 символов.' });
        await getState();
        const result = await fetch(`${upstream}/api/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-chat-token': upstreamToken, origin: upstream },
          body: JSON.stringify({ text, senderID: session.id, name: session.name }),
          signal: AbortSignal.timeout(10000),
        });
        if (!result.ok) throw new Error('Backend rejected message');
        session.lastSent = now();
        session.sent.push(now());
        return json(200, { ok: true });
      }
      // Never forward owner controls, OpenCode endpoints, arbitrary paths, files or SSE.
      return json(403, { error: 'Доступны только просмотр и отправка сообщений. Агентами управляет владелец.' });
    } catch {
      if (!res.headersSent) json(503, { error: 'Чат временно недоступен. Владелец должен оставить компьютер и сервер включёнными.' });
      else res.end();
    }
  });
}
