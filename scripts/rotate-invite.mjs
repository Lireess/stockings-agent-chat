import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const target = path.resolve(import.meta.dirname, '..', 'share-private.json');
await writeFile(target, JSON.stringify({ inviteCode: randomBytes(24).toString('base64url') }, null, 2), { mode: 0o600 });
console.log('Создан новый секрет приглашения. Он сохранён только в share-private.json.');
console.log('Чтобы отозвать старый доступ, остановите и заново запустите share.mjs.');
