// index.js
// QA Wolf Take-Home — HN /newest order check with CLI flags & artifacts
//
// Flags (use any combo):
//   --show   : run headful (show browser)     | or set HEADLESS=false
//   --csv    : write artifacts/top100.csv
//   --junit  : write artifacts/results.xml (JUnit)
//   --trace  : record Playwright trace.zip
//
// Examples:
//   node index.js --show
//   node index.js --csv --junit --trace
//   HEADLESS=false node index.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HN_URL = 'https://news.ycombinator.com/newest';
const TARGET_COUNT = 100;
const TIMEOUT_MS = 30_000;

const args = new Set(process.argv.slice(2));
const headless = !(args.has('--show') || String(process.env.HEADLESS).toLowerCase() === 'false');
const WANT_CSV = args.has('--csv');
const WANT_JUNIT = args.has('--junit');
const WANT_TRACE = args.has('--trace');

// Ensure folders exist
const screenshotDir = path.join(process.cwd(), 'screenshots');
const artifactsDir = path.join(process.cwd(), 'artifacts');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir);

// ---------- Helpers ----------
function parseRelativeAge(text) {
    const now = Date.now();
    const lower = (text || '').toLowerCase();
    if (lower.includes('yesterday')) return now - 86_400_000;
    const m = lower.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
    if (!m) return null;
    const qty = parseInt(m[1], 10);
    const unit = m[2];
    const unitMs = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000 }[unit];
    return now - qty * unitMs;
}
const toSec = (ms) => Math.floor(ms / 1000);

async function grabBatchOfItems(page) {
    const items = await page.$$eval('tr.athing', (rows) => {
        function getTs(ageEl) {
            if (!ageEl) return { tsMs: null, ageText: '' };
            const titleAttr = ageEl.getAttribute('title');
            if (titleAttr) {
                const abs = Date.parse(titleAttr);
                if (!Number.isNaN(abs)) return { tsMs: abs, ageText: ageEl.textContent?.trim() || '' };
            }
            const text = ageEl.textContent?.trim() || '';
            return { tsMs: null, ageText: text };
        }
        return rows.map((row) => {
            const id = row.getAttribute('id') || '';
            const a = row.querySelector('.titleline a');
            const sub = row.nextElementSibling;
            const ageEl = sub?.querySelector('.age a') || sub?.querySelector('.age');
            const { tsMs, ageText } = getTs(ageEl);
            return { id, title: a?.textContent?.trim() || '', url: a?.getAttribute('href') || '', tsMs, ageText };
        });
    });

    for (const it of items) {
        if (it.tsMs == null && it.ageText) it.tsMs = parseRelativeAge(it.ageText);
        if (it.tsMs != null) it.tsSec = toSec(it.tsMs);
    }
    return items.filter((it) => it.title && Number.isFinite(it.tsSec));
}

function checkSortedNewestToOldest(items) {
    for (let i = 0; i < items.length - 1; i++) {
        const a = items[i], b = items[i + 1];
        if (a.tsSec > b.tsSec) continue;      // newer first -> ok
        if (a.tsSec === b.tsSec) continue;    // tie allowed -> keep DOM order
        return { ok: false, index: i, a, b };
    }
    return { ok: true };
}

function writeCSV(first100) {
    const csv = [
        'index,iso_time,title,url,id',
        ...first100.map((it, i) =>
            `${i},"${new Date(it.tsSec * 1000).toISOString().replace(/"/g, '""')}","${it.title.replace(/"/g, '""')}",${it.url},${it.id}`
        )
    ].join('\n');
    const p = path.join(artifactsDir, 'top100.csv');
    fs.writeFileSync(p, csv);
    console.log('   CSV saved → artifacts/top100.csv');
}

function writeJUnit({ passed, message }) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="hn-newest-sort" tests="1" failures="${passed ? 0 : 1}">
  <testcase classname="hn" name="first-100-sorted">
    ${passed ? '' : `<failure message="Order check failed"><![CDATA[${message}]]></failure>`}
  </testcase>
</testsuite>`;
    fs.writeFileSync(path.join(artifactsDir, 'results.xml'), xml);
    console.log('   JUnit saved → artifacts/results.xml');
}

// ---------- Main ----------
(async () => {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();

    if (WANT_TRACE) {
        await context.tracing.start({ screenshots: true, snapshots: true });
    }

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    try {
        await page.goto(HN_URL, { waitUntil: 'domcontentloaded' });

        const all = [];
        let pageHops = 0;
        const MAX_PAGES = 10; // guardrail

        while (all.length < TARGET_COUNT && pageHops < MAX_PAGES) {
            const batch = await grabBatchOfItems(page);
            for (const it of batch) if (all.length < TARGET_COUNT) all.push(it);
            if (all.length >= TARGET_COUNT) break;

            const more = page.locator('a.morelink');
            // retry a couple times if "More" is late to render
            let clicked = false;
            for (let attempt = 1; attempt <= 2; attempt++) {
                if (await more.isVisible()) {
                    await Promise.all([page.waitForLoadState('domcontentloaded'), more.click()]);
                    clicked = true;
                    pageHops++;
                    break;
                }
                await page.waitForTimeout(500);
            }
            if (!clicked) throw new Error(`Only collected ${all.length}; no "More" link.`);
        }

        const first100 = all.slice(0, TARGET_COUNT);
        const res = checkSortedNewestToOldest(first100);

        if (!res.ok) {
            const { index: i, a, b } = res;
            const msg = `break at index ${i}
A: ${a.title}  ${new Date(a.tsSec * 1000).toISOString()}
B: ${b.title}  ${new Date(b.tsSec * 1000).toISOString()}`;
            console.error('❌ FAIL: Not sorted newest→oldest at index', i);
            console.error(msg);
            const shot = path.join(screenshotDir, 'failure.png');
            await page.screenshot({ path: shot, fullPage: true });
            console.error(`   Screenshot saved: ${shot}`);
            if (WANT_JUNIT) writeJUnit({ passed: false, message: msg });
            process.exitCode = 1;
            return;
        }

        const newest = new Date(first100[0].tsSec * 1000).toISOString();
        const oldest = new Date(first100[99].tsSec * 1000).toISOString();
        console.log('✅ PASS: Exactly first 100 articles are sorted newest → oldest.');
        console.log(`   Newest (index 0):  ${newest}`);
        console.log(`   Oldest (index 99): ${oldest}`);

        console.log('\nSample of the first 5 items:');
        first100.slice(0, 5).forEach((it, i) => {
            console.log(`${String(i).padStart(2, '0')}  ${new Date(it.tsSec * 1000).toISOString()}  ${it.title}`);
        });

        if (WANT_CSV) writeCSV(first100);
        if (WANT_JUNIT) writeJUnit({ passed: true, message: '' });
    } catch (err) {
        console.error('❌ ERROR:', err.message || err);
        try {
            const shot = path.join(screenshotDir, 'error.png');
            await page.screenshot({ path: shot, fullPage: true });
            console.error(`   Screenshot saved: ${shot}`);
        } catch { }
        if (WANT_JUNIT) writeJUnit({ passed: false, message: String(err?.stack || err) });
        process.exitCode = 1;
    } finally {
        if (WANT_TRACE) {
            await context.tracing.stop({ path: path.join(artifactsDir, 'trace.zip') });
            console.log('   Trace saved → artifacts/trace.zip (view with: npx playwright show-trace artifacts/trace.zip)');
        }
        await browser.close();
    }
})();
