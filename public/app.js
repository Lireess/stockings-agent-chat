const $ = id => document.getElementById(id);
let state = null;
let token = '';
let connected = false;
let pending = false;
let filter = '';
let rendered = '';
let agentRendered = false;
const conversation = $('conversation');
const time = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function person(agent) {
  const row = element('div', 'person');
  row.append(element('span', `avatar ${agent.color}`, agent.initials));
  const copy = element('div', 'person-copy');
  copy.append(element('strong', '', agent.name), element('small', '', agent.role));
  row.append(copy, element('span', 'online-dot'));
  return row;
}
function renderMessages() {
  const key = JSON.stringify([state.messages, filter, state.viewerID]);
  if (key === rendered) return;
  rendered = key;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 130;
  const content = document.createDocumentFragment();
  let visible = 0;
  for (const m of state.messages) {
    const agent = state.agents.find(a => a.id === m.agent);
    if (filter && !`${m.text} ${agent?.name || m.name || ''}`.toLocaleLowerCase('ru-RU').includes(filter)) continue;
    visible++;
    if (m.agent === 'system') {
      const row = element('div', 'system-message');
      row.append(element('span', '', m.text));
      content.append(row);
      continue;
    }
    const human = m.agent === 'user';
    const mine = human && (m.senderID || 'owner') === (state.viewerID || 'owner');
    const row = element('article', `message-row${mine ? ' mine' : ''}`);
    if (!mine && agent) row.append(element('span', `avatar ${agent.color}`, agent.initials));
    if (human && !mine) row.append(element('span', 'avatar user-avatar', (m.name || 'Д')[0].toUpperCase()));
    const bubble = element('div', 'bubble');
    const heading = element('div', `bubble-heading ${human ? '' : `author-${agent?.color}`}`, mine ? 'Вы' : human ? m.name || 'Владелец' : agent?.name || 'Агент');
    if (agent) heading.append(element('span', 'role', agent.role));
    bubble.append(heading, element('p', 'bubble-text', m.text));
    const meta = element('div', 'bubble-meta');
    if (m.interrupted) meta.append(element('span', '', 'прервано'));
    else if (m.partial) meta.append(element('span', '', 'пишет…'));
    meta.append(element('time', '', time(m.time)));
    if (mine) meta.append(element('span', 'ticks', '✓✓'));
    bubble.append(meta);
    row.append(bubble);
    content.append(row);
  }
  $('messages').replaceChildren(content);
  $('no-results').hidden = !filter || visible > 0;
  $('welcome').classList.toggle('compact', state.messages.some(m => m.agent !== 'system'));
  $('welcome').hidden = !!filter;
  if (!filter && nearBottom) conversation.scrollTop = conversation.scrollHeight;
}
function render() {
  if (!state) return;
  if (!agentRendered) {
    for (const agent of state.agents) {
      $('sidebar-agents').append(person(agent));
      $('detail-agents').append(person(agent));
    }
    agentRendered = true;
  }
  const live = state.status === 'running';
  const stopping = state.status === 'stopping';
  const typing = state.agents.find(a => a.id === state.typing);
  $('header-status').textContent = !connected ? 'Соединение с чатом потеряно…' : typing ? `${typing.name} печатает… · 3 ИИ-агента` : live ? '3 ИИ-агента · обсуждение идёт' : stopping ? 'Останавливаем агентов…' : '3 ИИ-агента · разговор на паузе';
  const badge = $('live-badge');
  badge.replaceChildren(element('i'), document.createTextNode(live && connected ? 'В ЭФИРЕ' : 'ПАУЗА'));
  badge.classList.toggle('active', live && connected);
  $('start').textContent = state.messages.some(m => m.agent !== 'system' && m.agent !== 'user') ? '▶ Продолжить' : '▶ Начать разговор';
  $('start').hidden = live || state.canControl === false;
  $('stop').hidden = state.canControl === false;
  $('start').disabled = pending || stopping || !connected;
  $('stop').disabled = !live || pending || !connected;
  $('stop').textContent = stopping ? 'Останавливаем…' : '■ СТОП';
  $('run-description').replaceChildren(element('i'), document.createTextNode(!connected ? 'Нет соединения' : stopping ? 'Прерываем генерацию…' : live ? 'Агенты общаются' : 'Разговор на паузе'));
  $('turn-count').textContent = `${state.turns} / ${state.maxTurns} ответов`;
  $('typing').hidden = !typing || !live || !!filter;
  $('typing-text').textContent = typing ? `${typing.name} набирает сообщение` : '';
  $('send').disabled = !connected || pending;
  if (state.canControl === false) {
    $('leave').hidden = false;
    document.querySelector('.account strong').textContent = state.viewerName;
    document.querySelector('.account .avatar').textContent = state.viewerName[0].toUpperCase();
    document.querySelector('.account div span').textContent = 'Гость · общий чат';
    document.querySelector('.composer-hint span:last-child').textContent = 'Чат по приглашению';
    document.querySelector('.private-badge').textContent = '◈ По приглашению';
    document.querySelector('.details-footer').textContent = 'Чат на компьютере владельца';
    document.querySelector('.safety-card p').textContent = 'Вы можете писать в общую переписку. Запуск и остановка ИИ доступны владельцу.';
  }
  const latest = state.messages.filter(m => m.agent !== 'system').at(-1);
  if (latest) $('preview').textContent = latest.text;
  renderMessages();
}
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
async function post(route, data = {}) {
  const response = await fetch(`/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-token': token },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.');
  return result;
}
async function control(route) {
  if (pending) return;
  pending = true;
  notice('');
  render();
  try { await post(route); }
  catch (error) { notice(error.message); }
  finally { pending = false; render(); }
}
$('start').addEventListener('click', () => control('start'));
$('stop').addEventListener('click', () => control('stop'));
$('leave').addEventListener('click', async () => {
  try { await post('logout'); location.replace('/'); }
  catch (error) { notice(error.message); }
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (pending || !connected) return;
  const input = $('message-input');
  const text = input.value.trim();
  if (!text) return;
  pending = true;
  render();
  notice('');
  try {
    await post('message', { text });
    input.value = '';
    input.style.height = '';
    conversation.scrollTop = conversation.scrollHeight;
    if (state.status === 'paused') notice(state.canControl === false ? 'Сообщение отправлено. Можно общаться и без ИИ; агентов запускает владелец.' : 'Сообщение отправлено. Нажмите «Продолжить», чтобы агенты ответили.');
  } catch (error) { notice(error.message); }
  finally { pending = false; render(); input.focus(); }
});
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('message-input').addEventListener('input', event => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 100)}px`;
});
$('search').addEventListener('input', event => {
  filter = event.target.value.trim().toLocaleLowerCase('ru-RU');
  render();
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $('search').focus();
  }
  if (event.key === 'Escape') $('details').classList.remove('open');
});
$('info-toggle').addEventListener('click', () => $('details').classList.toggle('open'));
$('agents-tab').addEventListener('click', () => {
  $('details').classList.add('open');
  $('detail-agents').scrollIntoView({ block: 'nearest' });
});
$('all-tab').addEventListener('click', () => { filter = ''; $('search').value = ''; render(); });
$('chat-item').addEventListener('click', () => { filter = ''; $('search').value = ''; render(); conversation.scrollTop = conversation.scrollHeight; });
async function connect() {
  try {
    const response = await fetch('/api/state');
    if (response.status === 401) { location.reload(); return; }
    if (!response.ok) throw new Error('Чат недоступен.');
    const data = await response.json();
    token = data.controlToken;
    delete data.controlToken;
    state = data;
    connected = true;
    render();
    conversation.scrollTop = conversation.scrollHeight;
    if (state.polling) {
      // Cloudflare Quick Tunnels do not support SSE. Guests use short polling.
      const poll = async () => {
        try {
          const next = await fetch('/api/state', { signal: AbortSignal.timeout(12000) });
          if (next.status === 401) { location.reload(); return; }
          if (!next.ok) throw new Error('Нет связи');
          const data = await next.json();
          token = data.controlToken;
          state = data;
          connected = true;
          render();
        } catch {
          connected = false;
          render();
        }
        setTimeout(poll, document.hidden ? 5000 : 1000);
      };
      setTimeout(poll, 1000);
      return;
    }
    const stream = new EventSource('/api/events');
    stream.onopen = async () => {
      try {
        // A server restart rotates its CSRF token. Refresh it on every reconnection.
        const response = await fetch('/api/state', { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Чат недоступен');
        const data = await response.json();
        token = data.controlToken;
        state = { ...state, ...data };
        connected = true;
        notice('');
        render();
      } catch { connected = false; render(); }
    };
    stream.onmessage = event => { state = { ...state, ...JSON.parse(event.data) }; connected = true; render(); };
    stream.onerror = () => { connected = false; render(); notice('Переподключаемся. Если окно чата закрыто, агенты остановятся автоматически через 45 секунд.'); };
  } catch (error) {
    notice(`${error.message} Обновите страницу после запуска сервера.`);
    $('start').disabled = true;
    $('send').disabled = true;
  }
}
void connect();
