import { mkdir, access, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const tools = path.resolve(import.meta.dirname, '..', 'tools');
const destination = path.join(tools, 'cloudflared.exe');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Этот установщик рассчитан на Windows x64. Другие платформы требуют отдельной настройки туннеля.');
  process.exitCode = 1;
} else {
  let temporary;
  try {
    await mkdir(tools, { recursive: true });
    let exists = false;
    try { await access(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
      console.log('tools/cloudflared.exe уже существует. Установщик не перезаписывает имеющиеся файлы.');
    } else {
      const request = async url => {
        const response = await fetch(url, {
          headers: { 'user-agent': 'stockings-agent-chat-setup' },
          signal: AbortSignal.timeout(180000),
        });
        if (!response.ok) throw new Error(`Загрузка не удалась: HTTP ${response.status}`);
        return response;
      };
      console.log('Проверяем официальный релиз Cloudflare…');
      const release = await (await request('https://api.github.com/repos/cloudflare/cloudflared/releases/latest')).json();
      const asset = release.assets?.find(item => item.name === 'cloudflared-windows-amd64.exe');
      if (!asset?.browser_download_url?.startsWith('https://github.com/cloudflare/cloudflared/releases/download/') ||
          !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) {
        throw new Error('В официальном релизе не найден файл с опубликованной контрольной суммой SHA-256.');
      }
      console.log(`Скачиваем cloudflared ${release.tag_name}…`);
      const bytes = Buffer.from(await (await request(asset.browser_download_url)).arrayBuffer());
      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (`sha256:${checksum}` !== asset.digest) throw new Error('Контрольная сумма не совпадает. Файл не будет установлен.');
      temporary = path.join(tools, `cloudflared-${randomUUID()}.download`);
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, destination);
      temporary = undefined;
      console.log('Готово: tools/cloudflared.exe. Контрольная сумма SHA-256 проверена.');
      console.log('При работающем основном сервере запустите: npm run share');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }
}
