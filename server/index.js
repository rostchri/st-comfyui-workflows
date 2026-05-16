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
 * Backend URLs are configured via env vars (see below). Defaults point to
 * the example placeholder — production deployments set them to the internal
 * (VPN / Tailscale / Docker-network) URLs.
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
// Two upstream URLs because the comfyui-api FastAPI wrapper and the ComfyUI
// custom-node `api-proxy` live on different ports:
//
//   COMFYUI_API_URL  → comfyui-api wrapper (SaladTechnologies). Serves
//                       /workflow/<name>, /docs/json, /health.
//   COMFYUI_NODE_URL → ComfyUI itself, with the comfyui-api-proxy custom-node
//                       mounted at /api-proxy/. Serves /workflows-meta.
//
// In a Traefik-fronted setup these often look like one URL with a path-prefix
// router doing the split. For internal Tailscale we keep them explicit.
const DEFAULT_API_URL = 'http://comfyui.example.local:3000';
const DEFAULT_NODE_URL = 'http://comfyui.example.local:8188/api-proxy';

function apiUrl() {
    return (process.env.COMFYUI_API_URL || process.env.COMFYUI_BASE_URL || DEFAULT_API_URL).replace(/\/$/, '');
}
function nodeUrl() {
    return (process.env.COMFYUI_NODE_URL || DEFAULT_NODE_URL).replace(/\/$/, '');
}

/**
 * Generic JSON proxy. Forwards method + body, returns the parsed JSON
 * (or the upstream error verbatim). `base` is one of apiUrl()/nodeUrl().
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
    console.log(`${LOG_PREFIX} server-side proxy ready (api=${apiUrl()} node=${nodeUrl()})`);

    // Liveness / config-visibility endpoint
    router.get('/health', (_req, res) => {
        res.json({ ok: true, api: apiUrl(), node: nodeUrl() });
    });

    // Workflow-Discovery → ComfyUI custom-node (lebt am ComfyUI-Port, nicht
    // am comfyui-api Port). Pfad ist `/workflows-meta` unter nodeUrl().
    router.get('/workflows-meta', (req, res) => proxyJson(req, res, nodeUrl(), '/workflows-meta'));

    // OpenAPI-Schema → comfyui-api wrapper.
    router.get('/docs/json', (req, res) => proxyJson(req, res, apiUrl(), '/docs/json'));

    // Render → comfyui-api wrapper.
    //
    // Logging analog zum NanoGPT-Pattern in SillyTavern's stable-diffusion
    // extension: input ausfuehrlich damit Prompt + alle Parameter im
    // container-log nachvollziehbar sind.
    router.post('/workflow/:name', (req, res) => {
        const name = req.params.name;
        // eslint-disable-next-line no-console
        console.debug(`${LOG_PREFIX} render request workflow=${name} input=`, req.body?.input);
        return proxyJson(req, res, apiUrl(), `/workflow/${encodeURIComponent(name)}`);
    });
}

async function exit() {
    // nothing to clean up — fetch is fire-and-forget
}

module.exports = { init, exit };
