/**
 * st-comfyui-workflows — server-side proxy.
 *
 * Loaded by `st-ext-server-loader` (see
 * https://github.com/rostchri/st-ext-server-loader) which mounts this
 * router at /api/plugins/st-ext-server-loader/ext/st-comfyui-workflows/...
 *
 * Routes proxied to ComfyUI-API (SaladTechnologies/comfyui-api):
 *   - GET  /workflows-meta  → list workflows + their metadata
 *   - GET  /docs/json       → OpenAPI schema per workflow
 *   - POST /workflow/:name  → render a workflow (body: {input: {...}})
 *
 * Browser counterpart calls these via:
 *   fetch('/api/plugins/st-ext-server-loader/ext/st-comfyui-workflows/...', ...)
 *
 * Backend-URL is configured via env var COMFYUI_BASE_URL. Default points to
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

const LOG_PREFIX = '[st-comfyui-workflows]';
const DEFAULT_BACKEND = 'http://comfyui.example.local:3000';

function backendUrl() {
    return (process.env.COMFYUI_BASE_URL || DEFAULT_BACKEND).replace(/\/$/, '');
}

/**
 * Generic JSON proxy. Forwards method + body, returns the parsed JSON
 * (or the upstream error verbatim).
 */
async function proxyJson(req, res, path) {
    const url = `${backendUrl()}${path}`;
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
    console.log(`${LOG_PREFIX} server-side proxy ready (backend=${backendUrl()})`);

    // Liveness / config-visibility endpoint
    router.get('/health', (_req, res) => {
        res.json({ ok: true, backend: backendUrl() });
    });

    // Workflow discovery
    router.get('/workflows-meta', (req, res) => proxyJson(req, res, '/workflows-meta'));
    router.get('/docs/json', (req, res) => proxyJson(req, res, '/docs/json'));

    // Render — analog zum NanoGPT-Pattern in SillyTavern's stable-diffusion
    // extension. Wir loggen den eingehenden input ausfuehrlich damit der
    // generierte Prompt + alle Parameter im container-log nachvollziehbar sind.
    router.post('/workflow/:name', (req, res) => {
        const name = req.params.name;
        // eslint-disable-next-line no-console
        console.debug(`${LOG_PREFIX} render request workflow=${name} input=`, req.body?.input);
        return proxyJson(req, res, `/workflow/${encodeURIComponent(name)}`);
    });
}

async function exit() {
    // nothing to clean up — fetch is fire-and-forget
}

module.exports = { init, exit };
