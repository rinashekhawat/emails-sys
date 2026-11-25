const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ================= CONFIG (100% ENV / SECRETS) =================
const API_KEY = process.env.API_KEY || '';
const UPLOAD_API_URL = (process.env.UPLOAD_API_URL || '').trim();
const UPLOAD_API_KEY = (process.env.UPLOAD_KEY || '').trim();
const FONT_URL = (process.env.FONT_URL || '').trim();
const WATERMARK_TEXT = (process.env.WATERMARK_TEXT || '').trim();
const UPLOAD_CONCURRENCY = 5;

const CARD_WIDTH = 300;
const CARD_HEIGHT = 150;
const SCALE_FACTOR = 4; // 300x150 @ 4x = Exact 1200x600 px
const PAGE_RECYCLE_LIMIT = 500;

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const FONT_FACE_CSS = FONT_URL
    ? `@font-face {
    font-family: 'SFProText';
    src: url('${FONT_URL}') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    font-display: block;
  }`
    : '';

const SAFE_WATERMARK = escapeHtml(WATERMARK_TEXT);

const TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  ${FONT_FACE_CSS}
  * {
    box-sizing: border-box;
  }
  html, body {
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #0f172a;
    font-family: 'SFProText', -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
</style>
</head>
<body>
  <div
    id="card"
    style="
      position: relative;
      width: 300px;
      height: 150px;
      background: #0f172a;
      background: linear-gradient(135deg, #1d1919 0%, #45302f 50%, #704c50 100%);
      border: 1px solid rgba(242, 190, 174, 0.20);
      border-radius: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 16px;
      text-align: center;
      box-sizing: border-box;
      overflow: hidden;
    "
  >
    <div
      style="
        position: absolute;
        top: -40px;
        left: -40px;
        width: 160px;
        height: 160px;
        background: radial-gradient(circle, rgba(232,176,164,0.16) 0%, rgba(232,176,164,0) 70%);
        pointer-events: none;
      "
    ></div>

    <div
      style="
        position: absolute;
        bottom: -60px;
        right: -60px;
        width: 180px;
        height: 180px;
        background: radial-gradient(circle, rgba(245,204,182,0.19) 0%, rgba(245,204,182,0) 70%);
        pointer-events: none;
      "
    ></div>

    <h1
      style="
        position: relative;
        margin: 0;
        font-family: inherit;
        font-size: 14px;
        font-weight: 900;
        line-height: 1.35;
        letter-spacing: -0.01em;
        color: #f8f1ed;
        text-shadow: 0 1px 3px rgba(0,0,0,0.3), 0 0 20px rgba(242,190,174,0.10);
      "
    >
      Build a Stronger Online Presence<br />
      <span
        id="business-name"
        style="
          color: #f2c4b5;
          text-shadow: 0 1px 3px rgba(0,0,0,0.3), 0 0 18px rgba(242,196,181,0.32);
        "
      >Your Business</span><br />
      With A Modern Website &amp; Mobile App
    </h1>

    <div
      style="
        position: absolute;
        bottom: -28px;
        left: 0;
        right: 0;
        text-align: center;
        font-family: inherit;
        font-size: 40px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: rgba(255, 255, 255, 0.04);
        pointer-events: none;
      "
    >
      ${SAFE_WATERMARK}
    </div>

    <div
      style="
        position: absolute;
        top: -30px;
        left: 0;
        right: 0;
        text-align: center;
        font-family: inherit;
        font-size: 40px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: rgba(255, 255, 255, 0.03);
        pointer-events: none;
      "
    >
      ${SAFE_WATERMARK}
    </div>
  </div>
</body>
</html>`;

let browserInstance = null;
let warmPage = null;
let pageUseCount = 0;

let renderQueue = Promise.resolve();
function runExclusive(task) {
    const next = renderQueue.then(task, task);
    renderQueue = next.catch(() => {});
    return next;
}

function createConcurrencyLimiter(maxConcurrent) {
    let active = 0;
    const queue = [];
    const runNext = () => {
        if (active >= maxConcurrent || queue.length === 0) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                active--;
                runNext();
            });
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        runNext();
    });
}

const limitUpload = createConcurrencyLimiter(UPLOAD_CONCURRENCY);

function checkAuth(req, res, next) {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
}

function slugify(name, fallbackIndex) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug ? `${slug}.png` : `card-${fallbackIndex}.png`;
}

function extractBusinessNames(body) {
    const { businessNames, names, businesses, businessName, name, business } = body || {};

    const arr = businessNames || names || businesses;
    if (Array.isArray(arr)) {
        return {
            list: arr.map(v => String(v || '').trim()).filter(Boolean),
            explicitBulk: true
        };
    }

    const single = businessName ?? name ?? business;
    if (typeof single === 'string' && single.trim()) {
        if (/<next>|\n/i.test(single)) {
            return {
                list: single.split(/<next>|\r?\n/i).map(v => v.trim()).filter(Boolean),
                explicitBulk: true
            };
        }
        return { list: [single.trim()], explicitBulk: false };
    }

    return { list: [], explicitBulk: false };
}

async function uploadToCdn(pngBuffer) {
    if (!UPLOAD_API_URL || !UPLOAD_API_KEY) {
        throw new Error('UPLOAD_API_URL ya UPLOAD_KEY env secret missing hai.');
    }

    const t0 = Date.now();
    const payload = JSON.stringify({
        image: `data:image/png;base64,${pngBuffer.toString('base64')}`
    });

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
            const res = await fetch(UPLOAD_API_URL, {
                method: 'POST',
                headers: {
                    'x-api-key': UPLOAD_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: payload,
                signal: controller.signal
            });
            clearTimeout(timer);

            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success && data.url) {
                return {
                    url: data.url,
                    pathname: data.pathname || null,
                    contentType: data.contentType || 'image/png',
                    size: data.size || pngBuffer.length,
                    uploadMs: Date.now() - t0
                };
            }

            lastError = new Error(data.error || data.message || `CDN Upload HTTP ${res.status}`);
            if (res.status >= 400 && res.status < 500) break;
        } catch (err) {
            clearTimeout(timer);
            lastError = err;
        }

        if (attempt < 2) {
            await new Promise(r => setTimeout(r, 600));
        }
    }
    throw lastError || new Error('CDN upload failed');
}

async function getBrowser() {
    if (browserInstance && browserInstance.connected) {
        return browserInstance;
    }
    console.log('Launching Chromium...');
    browserInstance = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        headless: 'new',
        protocolTimeout: 180000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote'
        ]
    });

    browserInstance.on('disconnected', () => {
        console.log('Chromium disconnected. Resetting...');
        browserInstance = null;
        warmPage = null;
        pageUseCount = 0;
    });

    return browserInstance;
}

async function resetWarmPage() {
    if (warmPage && !warmPage.isClosed()) {
        await warmPage.close().catch(() => {});
    }
    warmPage = null;
    pageUseCount = 0;
}

async function getWarmPage() {
    if (warmPage && !warmPage.isClosed() && pageUseCount < PAGE_RECYCLE_LIMIT) {
        return warmPage;
    }

    await resetWarmPage();
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setViewport({
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        deviceScaleFactor: SCALE_FACTOR
    });

    await page.setContent(TEMPLATE_HTML, {
        waitUntil: FONT_URL ? 'networkidle0' : 'load',
        timeout: 20000
    });

    const fontLoaded = FONT_URL
        ? await page.evaluate(async () => {
              await Promise.race([
                  document.fonts.ready,
                  new Promise(r => setTimeout(r, 5000))
              ]);
              return document.fonts.check('900 14px SFProText');
          })
        : false;

    warmPage = page;
    pageUseCount = 0;
    console.log(`Warm page ready (1200x600 @ 4x | CustomFont: ${fontLoaded} | UploadConfigured: ${Boolean(UPLOAD_API_URL && UPLOAD_API_KEY)})`);
    return warmPage;
}

async function renderCard(page, businessName) {
    const t0 = Date.now();

    await page.evaluate(async (text) => {
        const el = document.getElementById('business-name');
        el.textContent = text;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, businessName);

    const rawPng = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }
    });

    const buffer = Buffer.from(rawPng);
    return {
        buffer,
        renderMs: Date.now() - t0,
        sizeKB: Number((buffer.length / 1024).toFixed(1))
    };
}

// ==========================================
// 1. HEALTH CHECK (Zero secret/domain leak)
// ==========================================
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        dimensions: `${CARD_WIDTH * SCALE_FACTOR}x${CARD_HEIGHT * SCALE_FACTOR}`
    });
});

// ==========================================
// 2. GET PARAMETER API
// ==========================================
app.get('/api/generate-image', checkAuth, async (req, res) => {
    const businessName = String(req.query.businessName || req.query.name || '').trim();
    if (!businessName) {
        return res.status(400).json({ error: "Query param '?name=...' bhejna zaroori hai." });
    }

    const wantUpload = req.query.upload === '1' || req.query.upload === 'true' || req.query.format === 'json';
    const wantRedirect = req.query.redirect === '1' || req.query.redirect === 'true';
    const startTime = Date.now();

    try {
        const shot = await runExclusive(async () => {
            const page = await getWarmPage();
            try {
                const out = await renderCard(page, businessName);
                pageUseCount++;
                return out;
            } catch (err) {
                await resetWarmPage();
                throw err;
            }
        });

        if (wantRedirect) {
            const uploaded = await limitUpload(() => uploadToCdn(shot.buffer));
            console.log(`[GET->REDIRECT] render=${shot.renderMs}ms upload=${uploaded.uploadMs}ms`);
            return res.redirect(302, uploaded.url);
        }

        if (wantUpload) {
            const uploaded = await limitUpload(() => uploadToCdn(shot.buffer));
            const totalTimeMs = Date.now() - startTime;
            console.log(`[GET->CDN] render=${shot.renderMs}ms upload=${uploaded.uploadMs}ms size=${shot.sizeKB}KB`);
            return res.status(200).json({
                success: true,
                mode: 'single',
                businessName,
                url: uploaded.url,
                pathname: uploaded.pathname,
                dimensions: '1200x600',
                size: uploaded.size,
                sizeKB: shot.sizeKB,
                renderMs: shot.renderMs,
                uploadMs: uploaded.uploadMs,
                totalTimeMs
            });
        }

        console.log(`[GET->PNG] render=${shot.renderMs}ms size=${shot.sizeKB}KB`);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `inline; filename="${slugify(businessName, 1)}"`);
        res.setHeader('Content-Length', shot.buffer.length);
        res.setHeader('X-Image-Dimensions', '1200x600');
        res.setHeader('X-Render-Time-Ms', String(shot.renderMs));
        return res.send(shot.buffer);
    } catch (error) {
        console.error('[GET ERROR]', error.message);
        return res.status(500).json({ error: 'Image generate nahi ho payi', details: error.message });
    }
});

// ==========================================
// 3. MAIN SINGLE + BULK POST ENDPOINT
// ==========================================
app.post('/api/generate-image', checkAuth, async (req, res) => {
    const { list, explicitBulk } = extractBusinessNames(req.body);
    if (list.length === 0) {
        return res.status(400).json({
            error: "Body mein 'businessName' (string) ya 'businessNames' (array) bhejna zaroori hai."
        });
    }

    const isBulk = explicitBulk || list.length > 1;
    const skipUpload = req.body.upload === false;
    const startTime = Date.now();

    try {
        if (!isBulk) {
            const bName = list[0];
            const shot = await runExclusive(async () => {
                const page = await getWarmPage();
                try {
                    const out = await renderCard(page, bName);
                    pageUseCount++;
                    return out;
                } catch (err) {
                    await resetWarmPage();
                    throw err;
                }
            });

            if (skipUpload) {
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('Content-Disposition', `inline; filename="${slugify(bName, 1)}"`);
                res.setHeader('Content-Length', shot.buffer.length);
                return res.send(shot.buffer);
            }

            const uploaded = await limitUpload(() => uploadToCdn(shot.buffer));
            const totalTimeMs = Date.now() - startTime;
            console.log(`[SINGLE->CDN] render=${shot.renderMs}ms upload=${uploaded.uploadMs}ms size=${shot.sizeKB}KB`);

            return res.status(200).json({
                success: true,
                mode: 'single',
                businessName: bName,
                url: uploaded.url,
                pathname: uploaded.pathname,
                dimensions: '1200x600',
                size: uploaded.size,
                sizeKB: shot.sizeKB,
                renderMs: shot.renderMs,
                uploadMs: uploaded.uploadMs,
                totalTimeMs
            });
        }

        const uploadPromises = [];

        await runExclusive(async () => {
            const page = await getWarmPage();
            try {
                for (let i = 0; i < list.length; i++) {
                    const bName = list[i];
                    const idx = i + 1;
                    const shot = await renderCard(page, bName);
                    pageUseCount++;

                    const task = limitUpload(async () => {
                        try {
                            const uploaded = await uploadToCdn(shot.buffer);
                            console.log(`[BULK ${idx}/${list.length}] OK render=${shot.renderMs}ms upload=${uploaded.uploadMs}ms`);
                            return {
                                index: idx,
                                success: true,
                                businessName: bName,
                                url: uploaded.url,
                                pathname: uploaded.pathname,
                                size: uploaded.size,
                                sizeKB: shot.sizeKB,
                                renderMs: shot.renderMs,
                                uploadMs: uploaded.uploadMs
                            };
                        } catch (uploadErr) {
                            console.error(`[BULK ${idx}/${list.length}] UPLOAD FAIL: ${uploadErr.message}`);
                            return {
                                index: idx,
                                success: false,
                                businessName: bName,
                                url: null,
                                error: uploadErr.message,
                                renderMs: shot.renderMs
                            };
                        }
                    });

                    uploadPromises.push(task);
                }
            } catch (err) {
                await resetWarmPage();
                throw err;
            }
        });

        const results = await Promise.all(uploadPromises);
        const totalTimeMs = Date.now() - startTime;
        const successCount = results.filter(r => r.success).length;
        const failedCount = results.length - successCount;

        console.log(`[BULK DONE] ${successCount}/${results.length} uploaded in ${(totalTimeMs / 1000).toFixed(2)}s`);

        return res.status(200).json({
            success: failedCount === 0,
            mode: 'bulk',
            dimensions: '1200x600',
            total: results.length,
            uploaded: successCount,
            failed: failedCount,
            totalTimeMs,
            urls: results.filter(r => r.url).map(r => r.url),
            images: results
        });
    } catch (error) {
        console.error('[POST ERROR]', error.message);
        return res.status(500).json({
            success: false,
            error: 'Image generate/upload karne mein error aayi',
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await getWarmPage().catch(err => console.error('Initial warmup failed:', err.message));
});
