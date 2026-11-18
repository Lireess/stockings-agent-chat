import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = import.meta.dirname;
const runtime = JSON.parse(await readFile(path.join(root, 'share-runtime.json'), 'utf8'));
function getProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }`], { encoding: 'utf8', windowsHide: true }).trim();
  return output ? JSON.parse(output) : null;
}
const tunnel = getProcess(runtime.tunnelPID);
if (tunnel?.ExecutablePath?.toLowerCase() === path.join(root, 'tools', 'cloudflared.exe').toLowerCase()) {
  try { process.kill(tunnel.ProcessId); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const gateway = getProcess(runtime.gatewayPID);
if (gateway?.Name === 'node.exe' && /share\.mjs/.test(gateway.CommandLine)) {
  try { process.kill(gateway.ProcessId); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
console.log('Public access stopped. Local chat is still at http://127.0.0.1:4317');
