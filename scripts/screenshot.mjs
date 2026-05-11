import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'http://localhost:5001';
const OUT = path.resolve('screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctxA = await browser.newContext({ viewport: { width: 600, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 600, height: 900 } });
const host = await ctxA.newPage();
const guest = await ctxB.newPage();
host.on('console', (m) => console.log('[host]', m.type(), m.text()));
guest.on('console', (m) => console.log('[guest]', m.type(), m.text()));

// 1. open home
await host.goto(URL);
await host.waitForSelector('#view-home:not(.hidden)');
await host.screenshot({ path: path.join(OUT, '01-home.png') });

// 2. host picks file -> becomes host
const sample = path.join(OUT, '..', 'sample.txt');
fs.writeFileSync(sample, 'P2P 文件分享演示。\n'.repeat(6000));
const sample2 = path.join(OUT, '..', 'notes.txt');
fs.writeFileSync(sample2, '第二个文件，更小一点。\n'.repeat(200));

await host.setInputFiles('#fileInput', [sample, sample2]);
await host.waitForSelector('#view-host:not(.hidden)');
await host.waitForFunction(() => $('shareLink')?.value?.includes('/r/'), null, { timeout: 5000 }).catch(() => {});
await host.waitForFunction(() => document.getElementById('shareLink').value.includes('/r/'));
const shareUrl = await host.locator('#shareLink').inputValue();
console.log('shareUrl:', shareUrl);
await host.screenshot({ path: path.join(OUT, '02-host-created.png') });

// 3. guest opens link
await guest.goto(shareUrl);
await guest.waitForSelector('#view-guest:not(.hidden)');
// wait for file list
await guest.waitForSelector('#guestFiles li.file');
await guest.waitForFunction(() => document.querySelectorAll('#guestFiles li.file').length >= 2, null, { timeout: 10000 });
// host should reflect 1 connected peer
await host.waitForFunction(() => document.getElementById('peerCount').textContent.includes('1'));
await guest.screenshot({ path: path.join(OUT, '03-guest-joined.png') });
await host.screenshot({ path: path.join(OUT, '03-host-peer-online.png') });

// 4. guest clicks download on first file
await guest.click('#guestFiles li.file:first-child button');
await guest.waitForSelector('#guestFiles li.file.done', { timeout: 15000 });
await guest.screenshot({ path: path.join(OUT, '04-guest-downloaded.png') });

await browser.close();
console.log('Screenshots written to', OUT);
