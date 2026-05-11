import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'http://localhost:5001';
const OUT = path.resolve('screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctxA = await browser.newContext({ viewport: { width: 640, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 640, height: 900 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();

pageA.on('console', (m) => console.log('[A]', m.type(), m.text()));
pageB.on('console', (m) => console.log('[B]', m.type(), m.text()));

await pageA.goto(URL);
await pageB.goto(URL);

// Wait for IDs to appear
await pageA.waitForFunction(() => document.getElementById('myId').textContent.length === 4);
await pageB.waitForFunction(() => document.getElementById('myId').textContent.length === 4);

const idA = await pageA.locator('#myId').textContent();
const idB = await pageB.locator('#myId').textContent();
console.log('IDs:', idA, idB);

// Screenshot initial state
await pageA.screenshot({ path: path.join(OUT, '01-initial.png') });

// A connects to B
await pageA.fill('#peerInput', idB);
await pageA.click('#connectBtn');

// Wait for the data channel to open on both sides
await pageA.waitForFunction(() => document.getElementById('dot').classList.contains('connected'), null, { timeout: 10000 });
await pageB.waitForFunction(() => document.getElementById('dot').classList.contains('connected'), null, { timeout: 10000 });
console.log('Both peers connected.');

await pageA.screenshot({ path: path.join(OUT, '02-connected-A.png') });
await pageB.screenshot({ path: path.join(OUT, '02-connected-B.png') });

// Send a real file from A to B
const tmpFile = path.join(OUT, '..', 'sample.txt');
const sample = 'Hello from P2P!\n'.repeat(8000); // ~128KB
fs.writeFileSync(tmpFile, sample);

const fileInputA = await pageA.locator('#fileInput');
await fileInputA.setInputFiles(tmpFile);

// Wait for the receive log entry on B to appear and complete
await pageB.waitForSelector('.log li.recv', { timeout: 10000 });
await pageB.waitForSelector('.log li.recv.done', { timeout: 15000 });
await pageA.waitForSelector('.log li.send.done', { timeout: 15000 });
console.log('Transfer completed.');

await pageA.screenshot({ path: path.join(OUT, '03-sent-A.png') });
await pageB.screenshot({ path: path.join(OUT, '03-received-B.png') });

// Side-by-side composite via two viewports stitched in HTML? Easier: just provide both.
await browser.close();
console.log('Screenshots written to', OUT);
