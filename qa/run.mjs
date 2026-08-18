// Tenner QA agent — drives the app in a real Chromium and writes a report.
// Usage: node run.mjs   (env: TENNER_URL, QA_EMAIL, QA_PASSWORD, FLOWS)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load qa/.env if present. Simple KEY=VALUE parser; quotes optional; # = comment.
// Values already set in the shell environment win.
(function loadEnv() {
  const p = join(__dirname, '.env');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const SHOT_DIR = join(__dirname, 'screenshots', RUN_ID);
const REPORT_PATH = join(__dirname, 'reports', `${RUN_ID}.md`);
mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(dirname(REPORT_PATH), { recursive: true });

const CFG = {
  url: process.env.TENNER_URL || 'https://mytenner.com',
  email: process.env.QA_EMAIL,
  password: process.env.QA_PASSWORD,
  headed: !!process.env.HEADED,
  slowMo: process.env.SLOWMO ? Number(process.env.SLOWMO) : 0,
  only: (process.env.FLOWS || '').split(',').map(s => s.trim()).filter(Boolean),
};

if (!CFG.email || !CFG.password) {
  console.error('Missing QA_EMAIL / QA_PASSWORD env. See qa/README.md.');
  process.exit(1);
}

// Auto-detect pre-installed Chromium in the managed env.
const launchOpts = { headless: !CFG.headed, slowMo: CFG.slowMo };
if (existsSync('/opt/pw-browsers/chromium')) {
  launchOpts.executablePath = '/opt/pw-browsers/chromium';
}

const flowFiles = ['auth', 'lists', 'profile', 'gift-page', 'comments'];
const flows = [];
for (const name of flowFiles) {
  const mod = await import(`./flows/${name}.mjs`);
  flows.push(mod.default);
}
const runList = CFG.only.length ? flows.filter(f => CFG.only.includes(f.name)) : flows;

const events = []; // { flow, step, status, note?, shot? }
function nowMs() { return Date.now(); }

async function main() {
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => events.push({ flow: '(page)', step: 'JS error', status: 'warn', note: String(e.message || e) }));
  page.on('console', m => {
    if (m.type() === 'error') events.push({ flow: '(console)', step: 'error', status: 'warn', note: m.text().slice(0, 300) });
  });
  // Capture failing HTTP responses so 404s / 500s show their URL in the report
  page.on('response', r => {
    if (r.status() >= 400) {
      events.push({ flow: '(network)', step: `HTTP ${r.status()}`, status: 'warn', note: r.url() });
    }
  });

  const startedAt = nowMs();
  for (const flow of runList) {
    const flowStart = nowMs();
    const ctx = makeCtx(page, flow.name);
    events.push({ flow: flow.name, step: '▶ start', status: 'info' });
    try {
      await flow.run({ ...ctx, cfg: CFG });
      events.push({ flow: flow.name, step: '✓ done', status: 'pass', note: `${nowMs() - flowStart}ms` });
    } catch (e) {
      const shot = await safeShot(page, `${flow.name}-FAILED`);
      events.push({ flow: flow.name, step: '✗ failed', status: 'fail', note: String(e.message || e), shot });
    }
  }
  const dur = nowMs() - startedAt;
  await browser.close();
  writeReport(dur);
  const failed = events.filter(e => e.status === 'fail').length;
  console.log(`\nQA run ${RUN_ID}: ${events.length} events, ${failed} failed. Report: ${REPORT_PATH}`);
  process.exit(failed ? 1 : 0);
}

function makeCtx(page, flowName) {
  return {
    page,
    log(step, note) { events.push({ flow: flowName, step, status: 'info', note }); },
    async shot(name) { return await safeShot(page, `${flowName}-${name}`); },
    async assert(cond, message) {
      if (!cond) throw new Error(`assert failed: ${message}`);
      events.push({ flow: flowName, step: `✓ ${message}`, status: 'pass' });
    },
    async expectText(selector, needle, timeoutMs = 5000) {
      const el = page.locator(selector).first();
      await el.waitFor({ timeout: timeoutMs });
      const txt = (await el.textContent()) || '';
      if (!txt.toLowerCase().includes(String(needle).toLowerCase())) {
        throw new Error(`expected "${needle}" in ${selector}, got "${txt.trim().slice(0, 120)}"`);
      }
      events.push({ flow: flowName, step: `✓ text: "${needle}"`, status: 'pass' });
    },
  };
}

async function safeShot(page, label) {
  try {
    const path = join(SHOT_DIR, `${label}.png`);
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch { return null; }
}

function writeReport(durMs) {
  const rel = p => p ? p.replace(__dirname + '/', '') : '';
  const stats = events.reduce((a, e) => (a[e.status] = (a[e.status] || 0) + 1, a), {});
  let md = `# Tenner QA Report — ${RUN_ID}\n\n`;
  md += `**Target:** ${CFG.url}\n\n`;
  md += `**Duration:** ${(durMs / 1000).toFixed(1)}s\n\n`;
  md += `**Summary:** ${stats.pass || 0} pass · ${stats.fail || 0} fail · ${stats.warn || 0} warn · ${stats.info || 0} info\n\n`;
  md += `## Timeline\n\n`;
  let currentFlow = '';
  for (const e of events) {
    if (e.flow !== currentFlow) { md += `\n### ${e.flow}\n\n`; currentFlow = e.flow; }
    const icon = { pass: '✅', fail: '❌', warn: '⚠️', info: '·' }[e.status] || '·';
    md += `- ${icon} **${e.step}**${e.note ? ` — ${e.note}` : ''}`;
    if (e.shot) md += ` — [screenshot](${rel(e.shot)})`;
    md += `\n`;
  }
  writeFileSync(REPORT_PATH, md);
}

main().catch(e => { console.error(e); process.exit(2); });
