#!/usr/bin/env node
/**
 * Trimite emailurile din docs/GTM/emails/ via Resend.
 *
 *   RESEND_API_KEY=re_… SALES_FROM_EMAIL="Name <you@domain>" \
 *     node scripts/send-outreach.js --dry-run
 *   node scripts/send-outreach.js --only everfast
 *   node scripts/send-outreach.js --all
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const emailsDir = join(__dirname, '..', 'docs', 'GTM', 'emails');
const pipelinePath = join(__dirname, '..', 'docs', 'GTM', 'PIPELINE.md');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sendAll = args.includes('--all');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : '';

const apiKey = process.env.RESEND_API_KEY || '';
const from = process.env.SALES_FROM_EMAIL || '';
const replyTo = process.env.SALES_REPLY_TO || from;

if (!dryRun && (!apiKey || !from)) {
  console.error('Set RESEND_API_KEY and SALES_FROM_EMAIL (or use --dry-run).');
  process.exit(1);
}

const files = (await readdir(emailsDir))
  .filter((name) => name.endsWith('.md'))
  .sort();

const selected = files.filter((name) => {
  if (sendAll) return true;
  if (only) return name.includes(only);
  return false;
});

if (!selected.length) {
  console.error('Nothing to send. Use --all or --only <id> (e.g. everfast).');
  console.error('Available:', files.join(', '));
  process.exit(1);
}

for (const file of selected) {
  const raw = await readFile(join(emailsDir, file), 'utf8');
  const parsed = parseEmail(raw);
  if (!parsed.to || parsed.to.startsWith('#')) {
    console.warn(`SKIP ${file}: no concrete To: address (LinkedIn-only).`);
    continue;
  }
  const payload = {
    from,
    to: [parsed.to],
    ...(parsed.cc ? { cc: [parsed.cc] } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    subject: parsed.subject,
    text: parsed.body
  };
  console.log(`\n=== ${file} ===`);
  console.log(JSON.stringify({ to: payload.to, subject: payload.subject }, null, 2));
  if (dryRun) {
    console.log(payload.text.slice(0, 240) + '…');
    continue;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('FAILED', response.status, result);
    process.exitCode = 1;
    continue;
  }
  console.log('SENT', result.id || result);
  await appendPipelineLog(`Sent ${file} → ${parsed.to} (Resend ${result.id || 'ok'})`);
}

async function appendPipelineLog(line) {
  const stamp = new Date().toISOString().slice(0, 10);
  const chunk = `\n| ${stamp} | ${line} |`;
  try {
    const current = await readFile(pipelinePath, 'utf8');
    if (!current.includes(line)) {
      await writeFile(pipelinePath, `${current.trimEnd()}${chunk}\n`, 'utf8');
    }
  } catch {
    // ignore log failures
  }
}

function parseEmail(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = {};
  let bodyPart = raw;
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
    bodyPart = fm[2];
  }
  const subjectMatch = bodyPart.match(/\*\*Subject:\*\*\s*(.+)/);
  const subject = subjectMatch ? subjectMatch[1].trim() : '(no subject)';
  let body = bodyPart.replace(/\*\*Subject:\*\*\s*.+\n+/, '').trim();
  return {
    id: meta.id || '',
    to: meta.to || '',
    cc: meta.cc || '',
    subject,
    body
  };
}
