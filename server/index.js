/**
 * st-comfyui-workflows — server-side proxy.
 *
 * Loaded by `st-ext-server-loader` (see
 * https://github.com/rostchri/st-ext-server-loader) which mounts this
 * router at /api/plugins/st-ext-server-loader/ext/st-comfyui-workflows/...
 *
 * Routes proxied to rostchri/comfyui-api (single base URL):
 *   - GET  /workflows-meta  → list workflows + their metadata
 *   - GET  /docs/json       → OpenAPI schema per workflow
 *   - POST /workflow/:name  → render a workflow (body: {input: {...}})
 *   - GET  /progress/:id    → SSE stream of progress events
 *   - GET  /image/:filename → fetch the rendered PNG/WebP/MP4
 *
 * Browser counterpart calls these via:
 *   fetch('/api/plugins/st-ext-server-loader/ext/st-comfyui-workflows/...', ...)
 *
 * Backend-URL is configured via env var COMFYUI_API_URL. Default points to
 * the example placeholder — production deployments set it to the internal
 * (VPN / Tailscale / Docker-network) URL of their comfyui-api instance.
 *
 * Why this exists:
 *   - Centralised logging in the SillyTavern container (visible via
 *     `docker logs sillytavern`).
 *   - No CORS / cookie-credentials gymnastics in the browser.
 *   - Backend can sit on a private network (no public Traefik / auth proxy
 *     in front).
 *   - Future: auth tokens / API keys stay server-side instead of being
 *     embedded in the page.
 */

const crypto = require('crypto');
const LOG_PREFIX = '[st-comfyui-workflows]';
// Single base URL — rostchri/comfyui-api fork serves everything we need
// on the wrapper port (default :3000):
//
//   POST /workflow/<name>     — render submitted prompt
//   GET  /progress/<id>       — Server-Sent-Events progress stream
//   GET  /image/<filename>    — fetch the rendered PNG/WebP/MP4
//   GET  /workflows-meta      — aggregated *.meta.json sidecar files
//   GET  /docs/json           — OpenAPI schema (per workflow)
//
// Legacy `COMFYUI_NODE_URL` (port 8188 / api-proxy) is no longer used —
// we kept the env var name as a fallback only in case someone still
// has it set to the same host:port as the wrapper.
const DEFAULT_API_URL = 'http://comfyui.example.local:3000';

function apiUrl() {
    return (process.env.COMFYUI_API_URL || process.env.COMFYUI_BASE_URL || DEFAULT_API_URL).replace(/\/$/, '');
}

/**
 * Generic JSON proxy. Forwards method + body, returns the parsed JSON
 * (or the upstream error verbatim).
 */
async function proxyJson(req, res, base, path) {
    const url = `${base}${path}`;
    const init = {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = JSON.stringify(req.body || {});
    }
    const t0 = Date.now();
    try {
        const r = await fetch(url, init);
        const text = await r.text();
        const ms = Date.now() - t0;
        if (!r.ok) {
            console.warn(`${LOG_PREFIX} ${req.method} ${path} → HTTP ${r.status} (${ms}ms): ${text.slice(0, 300)}`);
            res.status(r.status);
        } else {
            console.log(`${LOG_PREFIX} ${req.method} ${path} → HTTP ${r.status} (${ms}ms)`);
        }
        // Forward content-type if upstream sent one, otherwise default to json.
        const ct = r.headers.get('content-type') || 'application/json; charset=utf-8';
        res.set('Content-Type', ct);
        return res.send(text);
    } catch (e) {
        console.error(`${LOG_PREFIX} ${req.method} ${path} → fetch threw:`, e);
        return res.status(502).json({ error: `upstream fetch failed: ${e.message}` });
    }
}

async function init(router) {
    console.log(`${LOG_PREFIX} server-side proxy ready (api=${apiUrl()})`);

    // Liveness / config-visibility endpoint
    router.get('/health', (_req, res) => {
        res.json({ ok: true, api: apiUrl() });
    });

    // Workflow-Discovery → comfyui-api wrapper (Fork-Feature: /workflows-meta
    // aggregiert die *.meta.json sidecar files, same shape wie der alte
    // /api-proxy/workflows-meta auf Port 8188).
    router.get('/workflows-meta', (req, res) => proxyJson(req, res, apiUrl(), '/workflows-meta'));

    // OpenAPI-Schema → comfyui-api wrapper.
    router.get('/docs/json', (req, res) => proxyJson(req, res, apiUrl(), '/docs/json'));

    // Render → comfyui-api wrapper. Wrapper is forked
    // (rostchri/comfyui-api with KEEP_OUTPUT_FILES=true + RETURN_BASE64=false)
    // so the response has no base64 anymore — just filenames + metadata.
    //
    // We replace the upstream response's `filenames`-only output with an
    // `image` field pointing at this plugin's /image/<filename> route. That
    // route lazy-streams from ComfyUI's /view endpoint when the browser
    // actually paints the chat message. Net result: ~14 KB response to the
    // browser, no base64 round-trip anywhere.
    //
    // Logging analog zum NanoGPT-Pattern in SillyTavern's stable-diffusion
    // extension: input ausfuehrlich damit Prompt + alle Parameter im
    // container-log nachvollziehbar sind.
    router.post('/workflow/:name', async (req, res) => {
        const name = req.params.name;
        // Idempotency: take client-supplied id (header or body), else mint a
        // UUID. Forked comfyui-api treats request.body.id and the
        // Idempotency-Key header as dedup keys — same key, same render.
        const body = req.body || {};
        const idemKey =
            req.get('idempotency-key') ||
            req.get('x-idempotency-key') ||
            body.id ||
            crypto.randomUUID();
        body.id = idemKey;
        // eslint-disable-next-line no-console
        console.debug(`${LOG_PREFIX} render request workflow=${name} id=${idemKey} input=`, body.input);

        const t0 = Date.now();
        const url = `${apiUrl()}/workflow/${encodeURIComponent(name)}`;
        let upstreamResp;
        try {
            upstreamResp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey,
                },
                body: JSON.stringify(body),
            });
        } catch (e) {
            console.error(`${LOG_PREFIX} POST /workflow/${name} → fetch threw:`, e);
            return res.status(502).json({ error: `upstream fetch failed: ${e.message}` });
        }
        const ms = Date.now() - t0;
        const text = await upstreamResp.text();
        if (!upstreamResp.ok) {
            console.warn(`${LOG_PREFIX} POST /workflow/${name} → HTTP ${upstreamResp.status} (${ms}ms): ${text.slice(0, 300)}`);
            res.status(upstreamResp.status);
            res.set('Content-Type', upstreamResp.headers.get('content-type') || 'application/json');
            return res.send(text);
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error(`${LOG_PREFIX} POST /workflow/${name} → upstream returned non-JSON`);
            return res.status(502).json({ error: 'upstream returned non-JSON' });
        }

        const filename = data.filenames?.[0];
        if (!filename) {
            console.log(`${LOG_PREFIX} POST /workflow/${name} → HTTP 200 (${ms}ms, no filenames?) — forwarding response as-is`);
            return res.json(data);
        }

        // Build same-origin URL pointing at our /image/<filename> proxy route.
        // Browser fetches lazy through it; route forwards to wrapper /image.
        const imageUrl = `/api/plugins/st-ext-server-loader/ext/st-comfyui-workflows/image/${encodeURIComponent(filename)}`;
        const slim = {
            image: imageUrl,
            id: data.id,
            filenames: data.filenames,
            stats: data.stats,
            input: data.input,
            prompt: data.prompt,
        };
        // Optional: also strip `images` if forked wrapper still sent any
        // (shouldn't, but defensive).
        if (Array.isArray(data.images) && data.images.length > 0) {
            console.warn(`${LOG_PREFIX} upstream still returned ${data.images.length} base64 image(s) — forked wrapper not active? Dropping them.`);
        }

        console.log(`${LOG_PREFIX} POST /workflow/${name} → HTTP 200 (${ms}ms) → image url=${imageUrl}`);
        return res.json(slim);
    });

    // Progress-Stream-Proxy: tunnels comfyui-api's SSE endpoint through the
    // ST-internal route so the browser can keep same-origin policy and pick
    // up CSRF/cookies for free. The browser opens
    //   new EventSource('/api/plugins/.../progress/<id>')
    // in parallel with POST /workflow and reads 'progress', 'executing',
    // 'executed', 'execution_success' events. The upstream closes on the
    // terminal event; we just pipe it through.
    router.get('/progress/:id', async (req, res) => {
        const id = req.params.id;
        if (!id || id.length > 128 || /[^a-zA-Z0-9_.:-]/.test(id)) {
            return res.status(400).json({ error: 'invalid id' });
        }
        const upstream = `${apiUrl()}/progress/${encodeURIComponent(id)}`;
        console.log(`${LOG_PREFIX} GET /progress/${id} → opening upstream SSE`);

        // Server-side fetch with streaming body. Node's undici/fetch returns
        // a ReadableStream we can pipe through.
        let r;
        try {
            r = await fetch(upstream, {
                method: 'GET',
                headers: { Accept: 'text/event-stream' },
            });
        } catch (e) {
            console.error(`${LOG_PREFIX} GET /progress/${id} → upstream threw:`, e);
            return res.status(502).json({ error: `upstream fetch failed: ${e.message}` });
        }
        if (!r.ok || !r.body) {
            console.warn(`${LOG_PREFIX} GET /progress/${id} → upstream HTTP ${r.status}`);
            return res.status(r.status || 502).send(await r.text().catch(() => ''));
        }

        res.set('Content-Type', 'text/event-stream; charset=utf-8');
        res.set('Cache-Control', 'no-cache, no-transform');
        res.set('Connection', 'keep-alive');
        res.set('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        // Pipe upstream body → response. Node fetch body is a web ReadableStream;
        // convert to Node stream via Readable.fromWeb (Node 18+).
        const { Readable } = require('stream');
        const nodeStream = Readable.fromWeb(r.body);

        const onClose = () => {
            try { nodeStream.destroy(); } catch (e) { /* ignore */ }
        };
        req.on('close', onClose);
        nodeStream.on('error', (e) => {
            console.warn(`${LOG_PREFIX} GET /progress/${id} → stream error:`, e.message);
            try { res.end(); } catch (_) { /* ignore */ }
        });
        nodeStream.pipe(res);
    });

    // Image-streaming proxy: streams the rendered file from the wrapper's
    // GET /image/<filename> endpoint (Fork-Feature). Browser puts a
    // same-origin URL in the chat (no base64 in chat.json, no upload
    // round-trip), and the actual file download only happens when the
    // message is rendered.
    router.get('/image/:filename', async (req, res) => {
        const fname = req.params.filename;
        if (!fname || fname.includes('..') || fname.includes('/')) {
            return res.status(400).json({ error: 'invalid filename' });
        }
        const upstreamUrl = `${apiUrl()}/image/${encodeURIComponent(fname)}`;
        try {
            const r = await fetch(upstreamUrl);
            if (!r.ok) {
                const errText = await r.text().catch(() => '');
                console.warn(`${LOG_PREFIX} GET /image/${fname} → upstream HTTP ${r.status}: ${errText.slice(0, 200)}`);
                return res.status(r.status).send(errText);
            }
            res.set('Content-Type', r.headers.get('content-type') || 'image/png');
            // Cache aggressively — same filename = same content.
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            const buf = Buffer.from(await r.arrayBuffer());
            return res.send(buf);
        } catch (e) {
            console.error(`${LOG_PREFIX} GET /image/${fname} → fetch threw:`, e);
            return res.status(502).json({ error: `upstream fetch failed: ${e.message}` });
        }
    });
}

async function exit() {
    // nothing to clean up — fetch is fire-and-forget
}

module.exports = { init, exit };
