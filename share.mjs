import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createGateway } from './share-gateway.mjs';

const root = import.meta.dirname;
const privateFile = path.join(root, 'share-private.json');
let config;
try { config = JSON.parse(await readFile(privateFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = { inviteCode: randomBytes(24).toString('base64url') };
  await writeFile(privateFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const backend = await fetch('http://127.0.0.1:4317/api/state', { signal: AbortSignal.timeout(5000) });
if (!backend.ok) throw new Error('Сначала запустите server.mjs на порту 4317.');
const gateway = createGateway({ inviteCode: config.inviteCode });
await new Promise((resolve, reject) => {
  gateway.once('error', reject);
  gateway.listen(4318, '127.0.0.1', resolve);
});
const executable = path.join(root, 'tools', 'cloudflared.exe');
const tunnel = spawn(executable, ['--no-autoupdate', 'tunnel', '--protocol', 'http2', '--url', 'http://127.0.0.1:4318'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let found = false;
let closing = false;
let buffer = '';
async function output(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  buffer = (buffer + text).slice(-16000);
  const match = buffer.match(/https:\/\/(?!api\.|www\.)[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !found) {
    found = true;
    const url = match[0];
    const link = `${url}/#invite=${encodeURIComponent(config.inviteCode)}`;
    await writeFile(path.join(root, 'share-link.txt'), link + '\n', { mode: 0o600 });
    await writeFile(path.join(root, 'share-runtime.json'), JSON.stringify({ gatewayPID: process.pid, tunnelPID: tunnel.pid, url }, null, 2));
    console.log(`\nСсылка-приглашение (отправьте только другу):\n${link}\n`);
  }
}
tunnel.stdout.on('data', chunk => { void output(chunk).catch(console.error); });
tunnel.stderr.on('data', chunk => { void output(chunk).catch(console.error); });
tunnel.on('error', error => { console.error(error.message); void shutdown(1); });
tunnel.on('exit', code => { if (!closing) { console.error(`Туннель завершился: ${code}`); void shutdown(code || 0); } });
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  tunnel.kill();
  gateway.closeAllConnections();
  gateway.close(() => process.exit(code));
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
