import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(rootDir, 'dist', 'it-inventory-node');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const item of ['src', 'public', 'seed', 'install', 'templates', 'package.json', 'README.md', 'DEPLOY.md']) {
  await cp(join(rootDir, item), join(distDir, item), { recursive: true });
}

await mkdir(join(distDir, 'data', 'uploads'), { recursive: true });
await mkdir(join(distDir, 'data', 'backups'), { recursive: true });
await writeFile(join(distDir, 'START-HERE.txt'), [
  'Inventar IT - pachet offline Node.js',
  '',
  '1. Copiaza acest folder pe Windows Server, de exemplu C:\\Apps\\ItInventory.',
  '2. Ruleaza PowerShell ca Administrator.',
  '3. Executa: powershell -ExecutionPolicy Bypass -File install\\Install-ItInventory.ps1',
  '4. Acceseaza din LAN: http://nume-server:8080',
  ''
].join('\r\n'), 'utf8');

console.log(`Pachet creat: ${distDir}`);
