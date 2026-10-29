#!/usr/bin/env node
// Makes the website's images with headless Chrome. No npm packages needed: Node 22+ and Google Chrome.
//
//   node src/tools/make-assets.mjs capture --app <web export>   screenshots of the real app → src/assets/screens/
//   node src/tools/make-assets.mjs render                       graphics from src/tools/scenes/ → src/assets/generated/
//
// `capture` needs the app's static web build (`npx expo export --platform web --output-dir <dir>` in the
// app's repository). It fills the app with the sample records below and photographs each screen at
// phone size. `render` opens every scene in SCENES, waits for fonts and images, and saves it in the
// listed formats. Both serve files over a local HTTP server so fonts and images load as on a website.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Only the app captures emulate a phone; scenes are plain pages of an exact size.
const PHONE = { width: 390, height: 844, scale: 3, mobile: true };

// Every graphic on the site. Sizes are CSS pixels; `scale` multiplies them for sharp images on retina
// screens, and an output's fourth value renders it smaller (0.5 = half size). Transparent scenes keep
// their alpha channel (WebP and PNG only), so they sit on the page's own background.
const SCENES = [
  { file: 'hero.html', width: 1200, height: 900, scale: 2, transparent: true, out: [['hero-2400', 'webp', 82], ['hero-1200', 'webp', 82, 0.5]] },
  { file: 'receipt-showcase.html', width: 1200, height: 1000, scale: 2, transparent: true, out: [['receipt-showcase-2400', 'webp', 84], ['receipt-showcase-1200', 'webp', 84, 0.5]] },
  ...['list', 'detail', 'stats', 'resolved'].map((name) => (
    { file: `phone.html?shot=${name}`, width: 460, height: 900, scale: 2, transparent: true, out: [[`phone-${name}-920`, 'webp', 84], [`phone-${name}-460`, 'webp', 84, 0.5]] })),
  { file: 'og-home.html', width: 1200, height: 630, scale: 1, out: [['og-image', 'png']] },
  ...['animals', 'history', 'how-long', 'vs', 'receipts'].map((name) => (
    { file: `article-card.html?card=${name}`, width: 1200, height: 630, scale: 1, out: [[`article-${name}`, 'jpeg', 86], [`article-${name}-1200`, 'webp', 84], [`article-${name}-600`, 'webp', 84, 0.5]] })),
  ...[512, 180, 32].map((size) => (
    { file: `icon.html?size=${size}`, width: size, height: size, scale: 1, transparent: true, out: [[`icon-${size}`, 'png']] })),
];

// ---------- the sample records the screenshots show ----------
function sampleRecords(now = Date.now()) {
  const day = 86_400_000;
  const at = (daysAgo, hours = 0) => new Date(now - daysAgo * day - hours * 3_600_000).toISOString();
  const stamp = new Date(now).toISOString();
  let n = 0;
  const g = (title, heatLevel, category, startDate, extra = {}) => ({
    id: `sample-${++n}`, title, heatLevel, category, startDate, status: 'active', createdAt: stamp, updatedAt: stamp, ...extra,
  });
  const resolved = (title, heatLevel, category, startDate, resolvedDate) =>
    g(title, heatLevel, category, startDate, { status: 'resolved', resolvedDate });
  return [
    g('My sister still has my hoodie', 'burning', 'family', at(2270)),
    g('"We should hang out sometime"', 'mild', 'friend', at(1460)),
    g('Ate my leftovers. Knew they were mine.', 'volcanic', 'other', at(731)),
    g('He never apologised', 'volcanic', 'family', at(412, 3), {
      note: 'Not at the time. Not at the wedding. Not since.',
      subtopics: [
        { id: 'st-1', text: 'Did not apologise at the time', createdAt: stamp },
        { id: 'st-2', text: 'Did not apologise at the wedding', createdAt: stamp },
        { id: 'st-3', text: 'Brought it up at Christmas, as a joke', createdAt: stamp },
      ],
    }),
    g('Said my haircut was "brave"', 'simmering', 'friend', at(241)),
    g('Spoiled the ending', 'burning', 'friend', at(92)),
    g('The promotion they gave to Marcus', 'burning', 'work', at(47, 5)),
    g('Replied "k"', 'simmering', 'relationship', at(3, 4)),
    resolved('The parking space thing', 'mild', 'stranger', at(97), at(2)),
    resolved('What she said in 2019', 'burning', 'friend', at(960), at(19)),
    resolved('The group chat incident', 'simmering', 'friend', at(60), at(32)),
  ];
}

// ---------- a tiny static file server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function serve(root, fallback = () => null) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const candidates = [path, path + '.html', join(path, 'index.html'), fallback(path)].filter(Boolean);
    for (const c of candidates) {
      const file = join(root, c);
      if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
        return res.end(readFileSync(file));
      }
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---------- Chrome over the DevTools protocol ----------
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'grudge-assets-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb',
    '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) {
        const cdp = await connect(page.webSocketDebuggerUrl);
        const close = async () => {
          const exited = new Promise((r) => proc.once('exit', r));
          proc.kill();
          await exited;
          try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp folder; the OS cleans it up */ }
        };
        return { cdp, close };
      }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  proc.kill();
  throw new Error('Chrome did not start. Set CHROME to its executable.');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let next = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method) {
      for (const w of waiters.filter((w) => w.method === msg.method)) { waiters.splice(waiters.indexOf(w), 1); w.ok(msg.params); }
    }
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++next;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((ok) => waiters.push({ method, ok }));
  return new Promise((ok) => { ws.onopen = () => ok({ send, once, close: () => ws.close() }); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function open(cdp, url, { width, height, scale, mobile = false }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  // Fonts and images must be in before the picture is taken.
  await evaluate(cdp, `(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; })));
  })()`);
}

async function shoot(cdp, { width, height, scale, mobile = false }, format, quality, resize = 1) {
  if (resize !== 1) await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale * resize, mobile });
  const { data } = await cdp.send('Page.captureScreenshot', { format, ...(format === 'png' ? {} : { quality }), captureBeyondViewport: false });
  if (resize !== 1) await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  return Buffer.from(data, 'base64');
}

// Expo's Pressable listens for pointer events; a plain click() is not enough.
const pressByText = (text) => `(() => {
  const el = [...document.querySelectorAll('div,span,a')].filter((e) => e.textContent.trim() === ${JSON.stringify(text)}).pop();
  if (!el) return false;
  const fire = (type, target) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
  let n = el;
  for (let i = 0; i < 4 && n; i++) { fire('pointerdown', n); fire('pointerup', n); n.click(); n = n.parentElement; }
  return true;
})()`;

// ---------- capture: the real app ----------
async function capture(appDir) {
  const root = resolve(appDir);
  // Static export: dynamic routes are files named after their parameter.
  const { server, url } = await serve(root, (p) =>
    p.startsWith('/grudge/edit/') ? '/grudge/edit/[id].html' : p.startsWith('/grudge/') && p !== '/grudge/add' ? '/grudge/[id].html' : '/index.html');
  const out = join(SRC, 'assets', 'screens');
  mkdirSync(out, { recursive: true });
  const { cdp, close } = await launchChrome();
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await open(cdp, `${url}/`, PHONE);
    const store = JSON.stringify(JSON.stringify({ version: 1, grudges: sampleRecords() }));
    await evaluate(cdp, `localStorage.clear(); localStorage.setItem('grudge_clock_grudges', ${store}); localStorage.setItem('grudge_clock_theme', JSON.stringify('dark'));`);
    const settle = (ms = 1800) => sleep(ms);
    const snap = async (name) => { writeFileSync(join(out, `${name}.png`), await shoot(cdp, PHONE, 'png')); console.log('captured', name); };

    for (const [name, path] of [['list', '/'], ['detail', '/grudge/sample-4'], ['stats', '/stats'], ['resolved', '/resolved'], ['add', '/grudge/add']]) {
      await open(cdp, url + path, PHONE);
      await settle();
      await snap(name);
    }
    // The receipt is a modal: the whole screen, plus the paper alone (cut out at the card's own bounds).
    const cutReceipt = async (name, heading) => {
      const box = await evaluate(cdp, `(() => {
        const label = [...document.querySelectorAll('div,span')].find((e) => e.textContent.trim() === ${JSON.stringify(heading)});
        for (let n = label; n; n = n.parentElement) {
          const r = n.getBoundingClientRect();
          if (r.width > 320 && r.width < 380 && r.height > 300) return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return null;
      })()`);
      if (!box) return console.log(`skipped ${name}: receipt not found`);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
      writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
      console.log('captured', name);
    };
    await open(cdp, `${url}/stats`, PHONE);
    await settle();
    if (await evaluate(cdp, pressByText('Share receipt'))) {
      await settle(1500);
      await snap('receipt');
      await cutReceipt('receipt-full', 'RECEIPT OF GRIEVANCES');
    } else console.log('skipped receipt: button not found');
    await open(cdp, `${url}/grudge/sample-4`, PHONE);
    await settle();
    if (await evaluate(cdp, pressByText('Share receipt'))) {
      await settle(1500);
      await cutReceipt('receipt-single', 'ONE (1) GRIEVANCE');
    } else console.log('skipped single receipt: button not found');
  } finally {
    await close();
    server.close();
  }
}

// ---------- render: the designed graphics ----------
async function render(only) {
  const { server, url } = await serve(SRC);
  const out = join(SRC, 'assets', 'generated');
  mkdirSync(out, { recursive: true });
  const { cdp, close } = await launchChrome();
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    for (const scene of SCENES) {
      if (only && !scene.file.includes(only)) continue;
      await cdp.send('Emulation.setDefaultBackgroundColorOverride',
        scene.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
      await open(cdp, `${url}/tools/scenes/${scene.file}`, scene);
      await sleep(250);
      for (const [name, format, quality = 90, resize = 1] of scene.out) {
        const ext = format === 'jpeg' ? 'jpg' : format;
        const buf = await shoot(cdp, scene, format, quality, resize);
        writeFileSync(join(out, `${name}.${ext}`), buf);
        console.log(`rendered ${name}.${ext}`.padEnd(42), `${Math.round(buf.length / 1024)} KB`);
      }
    }
  } finally {
    await close();
    server.close();
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'capture') {
  const i = args.indexOf('--app');
  if (i < 0) { console.error('usage: make-assets.mjs capture --app <web export dir>'); process.exit(2); }
  await capture(args[i + 1]);
} else if (command === 'render') {
  await render(args[0]);
} else {
  console.error('usage: make-assets.mjs capture --app <dir> | render [scene filter]');
  process.exit(2);
}
