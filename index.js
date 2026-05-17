// st-comfyui-workflows — SillyTavern Third-Party Extension
//
// Talks to a self-hosted ComfyUI backend running SaladTechnologies/comfyui-api.
// Workflows + their parameter schemas are discovered dynamically via:
//   GET /api-proxy/workflows-meta
// + GET /api-proxy/docs/json
// The form for each workflow is generated from the OpenAPI schema.
//
// Zero patches to SillyTavern core files — registers its own settings-drawer
// section and slash-command `/sd-cw`.
//
// Browser ↔ ComfyUI: direct fetch(). Default Base-URL is configurable in
// settings. fetch() uses `credentials: 'include'` so cookie-based SSO
// (Authelia, oauth2-proxy, etc.) cross-subdomain works.

// ES Module imports — ST extensions are loaded as ES Modules. We import the
// real symbols instead of destructuring from `SillyTavern.*` (which varies
// across ST versions).
import { eventSource, event_types, saveSettingsDebounced, characters, this_chid, getThumbnailUrl, getRequestHeaders } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveBase64AsFile } from '../../../utils.js';

console.log('[st-comfyui-workflows] module loaded');

const MODULE_NAME = 'st-comfyui-workflows';
const EXTENSION_FOLDER = `third-party/${MODULE_NAME}`;
const SETTINGS_KEY = 'comfyui_workflows';

// All HTTP traffic to ComfyUI goes through the SillyTavern backend now.
// The browser extension calls the loader-mounted plugin routes, the plugin
// proxies to the real comfyui-api on its internal (Tailscale / private)
// network. The Base-URL is therefore fixed — there's nothing to configure
// in the browser anymore. To change the upstream, set COMFYUI_BASE_URL in
// the SillyTavern container's env.
const BACKEND_BASE = '/api/plugins/st-ext-server-loader/ext/st-comfyui-workflows';

// ---------------------------------------------------------------------------
// Settings-Persistenz (in extensionSettings unter SETTINGS_KEY)
// ---------------------------------------------------------------------------

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {
            workflow: '',
            // Pro Workflow eigener Param-State: {workflow_name: {param: value}}
            params: {},
        };
    }
    // base_url im stored state kann aus aelteren Versionen liegen — wird
    // nicht mehr verwendet (Backend-URL kommt aus dem ST-Container env).
    // Wir loeschen den Schluessel nicht aktiv um Migration sanft zu halten.
    return extension_settings[SETTINGS_KEY];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// API-Calls — gehen ueber den SillyTavern-Backend-Proxy (st-ext-server-loader).
// Der Browser fetcht same-origin gegen /api/plugins/...; ST-CSRF-Middleware
// schuetzt /api/* Routen, deshalb IMMER getRequestHeaders() nutzen — die
// Funktion setzt X-CSRF-Token + Content-Type automatisch korrekt.
// ---------------------------------------------------------------------------

async function fetchJSON(path, options = {}) {
    const url = `${BACKEND_BASE}${path}`;
    const headers = { ...getRequestHeaders(), ...(options.headers || {}) };
    const r = await fetch(url, { ...options, headers });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${url} — ${text.slice(0, 200)}`);
    }
    return r.json();
}

async function loadWorkflowsMeta() {
    const d = await fetchJSON('/workflows-meta');
    return d.workflows || {};
}

async function loadOpenAPI() {
    return fetchJSON('/docs/json');
}

// Generates a UUID. Prefer the browser-native API (Chrome 92+, FF 95+); fall
// back to a Math.random-based v4 for ancient browsers — we only need
// uniqueness for idempotency dedup, not cryptographic strength.
function mintRequestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Submit a workflow and (optionally) stream progress events back through the
 * provided callback. Returns the final JSON payload.
 *
 *   onProgress(kind, data)
 *     kind = 'queue' | 'execution_start' | 'executing' | 'progress' |
 *            'executed' | 'execution_success' | 'execution_error' | 'done'
 *
 * The Idempotency-Key + body.id make retries safe: comfyui-api dedups against
 * the same key; ComfyUI itself never sees two submissions for one user click.
 */
async function generate(workflow, input, onProgress) {
    const reqId = mintRequestId();

    let es = null;
    if (typeof EventSource !== 'undefined' && typeof onProgress === 'function') {
        try {
            es = new EventSource(`${BACKEND_BASE}/progress/${encodeURIComponent(reqId)}`);
            const kinds = [
                'queue',
                'prompt_meta',
                'execution_start',
                'executing',
                'progress',
                'executed',
                'execution_success',
                'execution_error',
                'done',
            ];
            for (const kind of kinds) {
                es.addEventListener(kind, (e) => {
                    let data = {};
                    try { data = JSON.parse(e.data); } catch (_) { /* ignore */ }
                    try { onProgress(kind, data); } catch (cbErr) {
                        console.warn(`[${MODULE_NAME}] progress callback threw:`, cbErr);
                    }
                });
            }
            // EventSource auto-reconnects on transient drops; silence the noise.
            es.addEventListener('error', () => { /* swallow */ });
        } catch (e) {
            console.warn(`[${MODULE_NAME}] EventSource setup failed (continuing without progress):`, e);
            es = null;
        }
    }

    try {
        return await fetchJSON(`/workflow/${encodeURIComponent(workflow)}`, {
            method: 'POST',
            headers: { 'Idempotency-Key': reqId },
            body: JSON.stringify({ id: reqId, input }),
        });
    } finally {
        if (es) { try { es.close(); } catch (_) { /* ignore */ } }
    }
}

// ---------------------------------------------------------------------------
// File-Upload-Helper — JPEG-DataURI weil PNG-DataURIs vom Wrapper korrumpiert
// werden (siehe Workflow-meta.json description).
// ---------------------------------------------------------------------------

async function fileToJpegDataUrl(file, quality = 0.92) {
    const bitmap = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0);
    return c.toDataURL('image/jpeg', quality);
}

// ---------------------------------------------------------------------------
// I2I-Image-Input-Block — File-Picker + Character-Avatar-Button + Preview.
// Wird im OpenAPI-Schema fuer das Feld `input_image` aufgerufen.
// ---------------------------------------------------------------------------

/**
 * Erzeugt ein DIV mit:
 *   - File-Input (klassischer browser-picker)
 *   - "Use character avatar"-Button (wenn aktueller Character vorhanden)
 *   - Preview-Image (sobald File gepickt oder Avatar gewaehlt)
 * Der zurueckgegebene Container traegt `data-paramName` damit
 * collectFormInput() ihn als Image-Source erkennt — die echten Bilddaten
 * landen in `container._pendingDataUrl` (string).
 */
function renderImageInputBlock(elementId, paramName) {
    const wrap = document.createElement('div');
    wrap.className = 'comfyui-wf-image-wrap';
    wrap.id = elementId;
    wrap.dataset.paramName = paramName;
    wrap.dataset.coerce = 'image-as-jpeg-dataurl';

    const fileRow = document.createElement('div');
    fileRow.className = 'comfyui-wf-image-buttons';

    // File-Picker als Label gestyled (OS-Default-Picker ist im dark-Theme
    // oft unsichtbar). Native input liegt im Label, display:none.
    const fileLabel = document.createElement('label');
    fileLabel.className = 'comfyui-wf-file-pick-label';
    const filePickIcon = document.createElement('span');
    filePickIcon.textContent = '📁 Datei waehlen…';
    fileLabel.appendChild(filePickIcon);
    const filenameSpan = document.createElement('span');
    filenameSpan.className = 'filename';
    filenameSpan.textContent = '';
    fileLabel.appendChild(filenameSpan);
    const filePick = document.createElement('input');
    filePick.type = 'file';
    filePick.accept = 'image/*';
    fileLabel.appendChild(filePick);
    fileRow.appendChild(fileLabel);

    // Avatar-Button (nur wenn aktueller Character vorhanden)
    const avatarBtn = document.createElement('button');
    avatarBtn.type = 'button';
    avatarBtn.className = 'menu_button comfyui-wf-avatar-btn';
    avatarBtn.textContent = '👤 Avatar';
    avatarBtn.title = 'Aktuellen Character-Avatar als Input-Bild verwenden';
    fileRow.appendChild(avatarBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'menu_button comfyui-wf-clear-btn';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Auswahl zuruecksetzen';
    fileRow.appendChild(clearBtn);

    wrap.appendChild(fileRow);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:0.75rem; color:#aaa !important;';
    hint.textContent = 'Datei waehlen ODER Char-Avatar nutzen. Wird automatisch zu JPEG konvertiert (PNG-DataURIs sind im Wrapper kaputt).';
    wrap.appendChild(hint);

    const preview = document.createElement('img');
    preview.style.cssText = 'max-width:240px; max-height:240px; border:1px solid #555; border-radius:4px; display:none;';
    wrap.appendChild(preview);

    // Wert wird in wrap._pendingDataUrl gespeichert (string) — collectFormInput liest das aus.
    function setDataUrl(url) {
        wrap._pendingDataUrl = url || null;
        if (url) {
            preview.src = url;
            preview.style.display = '';
        } else {
            preview.removeAttribute('src');
            preview.style.display = 'none';
        }
    }

    filePick.addEventListener('change', async () => {
        if (!filePick.files || filePick.files.length === 0) {
            filenameSpan.textContent = '';
            setDataUrl(null);
            return;
        }
        const file = filePick.files[0];
        filenameSpan.textContent = file.name;
        try {
            const url = await fileToJpegDataUrl(file);
            setDataUrl(url);
            hint.textContent = `${file.name} (${Math.round(file.size / 1024)} KB) → JPEG konvertiert.`;
            hint.style.color = '';
        } catch (e) {
            console.warn(`[${MODULE_NAME}] file → JPEG fehlgeschlagen:`, e);
            setDataUrl(null);
            hint.textContent = `Fehler: ${e.message}`;
            hint.style.color = '#f88';
        }
    });

    avatarBtn.addEventListener('click', async () => {
        try {
            const url = await getCurrentCharacterAvatarAsDataUrl();
            if (!url) {
                hint.textContent = 'Kein Avatar gefunden — Character auswaehlen oder eigenes Bild waehlen.';
                hint.style.color = '#f88';
                return;
            }
            setDataUrl(url);
            filePick.value = '';
            filenameSpan.textContent = '';
            hint.textContent = 'Avatar uebernommen.';
            hint.style.color = '';
        } catch (e) {
            console.warn(`[${MODULE_NAME}] avatar fetch failed:`, e);
            hint.textContent = `Avatar-Fetch fehlgeschlagen: ${e.message}`;
            hint.style.color = '#f88';
        }
    });

    clearBtn.addEventListener('click', () => {
        filePick.value = '';
        filenameSpan.textContent = '';
        setDataUrl(null);
        hint.textContent = 'Datei waehlen ODER Char-Avatar nutzen.';
        hint.style.color = '';
    });

    return wrap;
}

/**
 * Holt den Avatar des aktuell selektierten Characters und liefert ihn als
 * JPEG-DataURI. Returns null wenn kein Character selektiert.
 */
async function getCurrentCharacterAvatarAsDataUrl() {
    if (typeof this_chid === 'undefined' || this_chid === null) {
        // ST-Versionen koennen this_chid als undefined exposen — Fallback:
        // versuche aktuellen char aus characters-Array via globaler Variable.
        return null;
    }
    const id = this_chid;
    const char = characters && characters[id];
    if (!char || !char.avatar) return null;
    const url = typeof getThumbnailUrl === 'function'
        ? getThumbnailUrl('avatar', char.avatar)
        : `/characters/${encodeURIComponent(char.avatar)}`;
    // Same-origin fetch — der Avatar liegt im ST-Backend selbst
    const r = await fetch(url);
    if (!r.ok) throw new Error(`avatar HTTP ${r.status}`);
    const blob = await r.blob();
    // Blob → JPEG-DataURI via Canvas (gleicher Pfad wie fileToJpegDataUrl)
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0);
    return c.toDataURL('image/jpeg', 0.92);
}

// ---------------------------------------------------------------------------
// Dynamic-Form-Renderer aus OpenAPI-Schema (analog zu /container/comfyui/web/index.html)
// ---------------------------------------------------------------------------

function renderParamForm(formEl, openapi, workflow, savedParams) {
    formEl.innerHTML = '';
    const schemaPath = openapi?.paths?.[`/workflow/${workflow}`]?.post
        ?.requestBody?.content?.['application/json']?.schema;
    const inputSchema = schemaPath?.properties?.input;
    if (!inputSchema || inputSchema.type !== 'object') {
        formEl.innerHTML = '<i>kein Input-Schema gefunden</i>';
        return;
    }
    const props = inputSchema.properties || {};
    // Sort: prompt first, then "primary" if known, then rest
    const keys = Object.keys(props).sort((a, b) => {
        if (a === 'prompt') return -1;
        if (b === 'prompt') return 1;
        if (a === 'negative_prompt') return -1;
        if (b === 'negative_prompt') return 1;
        if (a === 'input_image') return -1;
        if (b === 'input_image') return 1;
        return a.localeCompare(b);
    });
    for (const key of keys) {
        const p = props[key];
        const row = document.createElement('div');
        row.className = 'comfyui-wf-row';
        const lbl = document.createElement('label');
        lbl.textContent = key;
        lbl.htmlFor = `comfyui_wf_p_${key}`;
        row.appendChild(lbl);

        let input;
        let coerce = 'string';
        const isImage = key === 'input_image';
        if (isImage) {
            // I2I-Bild-Block: file-picker + character-avatar-Button + preview.
            input = renderImageInputBlock(`comfyui_wf_p_${key}`, key);
            coerce = 'image-as-jpeg-dataurl';
        } else if (p.type === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.style.flex = '0';
            if (savedParams[key] === true || (savedParams[key] === undefined && p.default === true)) input.checked = true;
            coerce = 'boolean';
        } else if (p.type === 'object' && p.properties) {
            input = document.createElement('fieldset');
            input.style.cssText = 'border:1px solid var(--SmartThemeBorderColor); border-radius:4px; padding:0.4rem 0.6rem; flex:1';
            input.dataset.objectName = key;
            const lg = document.createElement('legend');
            lg.textContent = key;
            input.appendChild(lg);
            const saved = savedParams[key] || {};
            for (const [sk, sub] of Object.entries(p.properties)) {
                const sr = document.createElement('div');
                sr.style.cssText = 'display:flex; gap:0.4rem; align-items:center;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.style.flex = '0';
                cb.dataset.subKey = sk;
                if (saved[sk] === true || (saved[sk] === undefined && sub.default === true)) cb.checked = true;
                sr.appendChild(cb);
                const sl = document.createElement('label');
                sl.textContent = sub.description || sk;
                sl.style.cssText = 'flex:1; font-size:0.8rem;';
                if (sub.description) cb.title = sub.description;
                sr.appendChild(sl);
                input.appendChild(sr);
            }
            coerce = 'nested-object';
        } else if (p.type === 'integer' || p.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.className = 'text_pole';
            if (p.minimum != null) input.min = p.minimum;
            if (p.maximum != null) input.max = p.maximum;
            if (p.type === 'number') input.step = 'any';
            coerce = p.type === 'integer' ? 'int' : 'float';
        } else if (p.enum) {
            input = document.createElement('select');
            input.className = 'text_pole';
            for (const v of p.enum) {
                const o = document.createElement('option');
                o.value = v; o.textContent = v;
                input.appendChild(o);
            }
        } else if (key === 'prompt' || key === 'negative_prompt' || key === 'vl_prompt') {
            input = document.createElement('textarea');
            input.className = 'text_pole';
            input.rows = 2;
        } else {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'text_pole';
        }
        input.id = `comfyui_wf_p_${key}`;
        input.dataset.coerce = coerce;
        input.dataset.paramName = key;
        if (!isImage && coerce !== 'boolean' && coerce !== 'nested-object') {
            const v = savedParams[key] !== undefined ? savedParams[key] : p.default;
            if (v !== undefined && v !== null) input.value = v;
        }
        if (p.description) input.title = p.description;
        row.appendChild(input);
        formEl.appendChild(row);
    }
}

async function collectFormInput(formEl, statusEl) {
    const input = {};
    // Image-Input-Bloecke (DIV mit _pendingDataUrl) — pre-rendered, schon JPEG
    const imageBlocks = formEl.querySelectorAll('div[data-coerce="image-as-jpeg-dataurl"]');
    const skipChildren = new Set();
    for (const blk of imageBlocks) {
        const name = blk.dataset.paramName;
        if (name && blk._pendingDataUrl) {
            input[name] = blk._pendingDataUrl;
        }
        // alle inneren input/select/etc beim generischen Loop unten ueberspringen
        for (const el of blk.querySelectorAll('input, select, textarea, button')) {
            skipChildren.add(el);
        }
    }
    // Nested-Object-Fieldsets
    const nestedFieldsets = formEl.querySelectorAll('fieldset[data-object-name]');
    const nestedInputs = new Set();
    for (const fs of nestedFieldsets) {
        const obj = {};
        for (const cb of fs.querySelectorAll('input[type="checkbox"]')) {
            obj[cb.dataset.subKey] = cb.checked;
            nestedInputs.add(cb);
        }
        input[fs.dataset.objectName] = obj;
    }
    for (const el of formEl.querySelectorAll('input, select, textarea')) {
        if (nestedInputs.has(el) || skipChildren.has(el)) continue;
        const coerce = el.dataset.coerce || 'string';
        const name = el.dataset.paramName;
        if (!name) continue;
        if (coerce === 'image-as-jpeg-dataurl') continue;  // handled above
        if (coerce === 'boolean') {
            input[name] = el.checked;
            continue;
        }
        if (coerce === 'nested-object') continue;
        if (!el.value && el.value !== '0') continue;
        let v = el.value;
        if (coerce === 'int') v = parseInt(v, 10);
        else if (coerce === 'float') v = parseFloat(v);
        if (typeof v === 'number' && Number.isNaN(v)) continue;
        input[name] = v;
    }
    return input;
}

// ---------------------------------------------------------------------------
// Workflow-Card (display_name, description, tags, estimated-time)
// ---------------------------------------------------------------------------

function renderWorkflowCard(cardEl, meta) {
    if (!meta) {
        cardEl.style.display = 'none';
        return;
    }
    cardEl.style.display = '';
    const tags = (meta.tags || []).map(t => `<span class="tag">${t}</span>`).join('');
    cardEl.innerHTML = `
        <div class="title">${meta.display_name || ''}</div>
        <div>${meta.description || ''}</div>
        <div class="meta">
            ${tags}
            <span>· ${meta.category || '?'}</span>
            <span>· ~${meta.estimated_seconds_p50 || '?'}s</span>
            <span>· ${meta.output_format || '?'}</span>
            ${meta.requires_image_input ? '<span>· I2I</span>' : ''}
        </div>`;
}

// ---------------------------------------------------------------------------
// Hauptlogik — UI-Init + Generieren
// ---------------------------------------------------------------------------

let _workflowsMeta = {};
let _openapi = null;

async function loadAndPopulate(statusEl) {
    statusEl.className = 'comfyui-wf-status';
    statusEl.textContent = 'Lade /workflows-meta + /docs/json ...';
    try {
        const [meta, openapi] = await Promise.all([
            loadWorkflowsMeta(),
            loadOpenAPI(),
        ]);
        _workflowsMeta = meta;
        _openapi = openapi;
        const select = document.getElementById('comfyui_wf_workflow');
        select.innerHTML = '';
        const settings = getSettings();
        const names = Object.keys(meta).sort();
        for (const name of names) {
            const o = document.createElement('option');
            o.value = name;
            o.textContent = meta[name].display_name || name;
            if (name === settings.workflow) o.selected = true;
            select.appendChild(o);
        }
        statusEl.className = 'comfyui-wf-status success';
        statusEl.textContent = `OK — ${names.length} Workflow(s) verfuegbar.`;
        if (!settings.workflow && names.length) {
            settings.workflow = names[0];
            saveSettings();
        }
        rerenderForSelectedWorkflow();
    } catch (e) {
        statusEl.className = 'comfyui-wf-status error';
        statusEl.textContent = `Fehler: ${e.message}`;
    }
}

function rerenderForSelectedWorkflow() {
    const settings = getSettings();
    const name = document.getElementById('comfyui_wf_workflow').value;
    settings.workflow = name;
    saveSettings();
    const meta = _workflowsMeta[name];
    renderWorkflowCard(document.getElementById('comfyui_wf_wf_card'), meta);
    const form = document.getElementById('comfyui_wf_form');
    const savedParams = (settings.params || {})[name] || {};
    if (_openapi) renderParamForm(form, _openapi, name, savedParams);
}

async function generateClicked() {
    const settings = getSettings();
    const statusEl = document.getElementById('comfyui_wf_gen_status');
    const resultEl = document.getElementById('comfyui_wf_result');
    const btn = document.getElementById('comfyui_wf_generate');
    const workflow = document.getElementById('comfyui_wf_workflow').value;
    if (!workflow) {
        statusEl.className = 'comfyui-wf-status error';
        statusEl.textContent = 'Kein Workflow ausgewaehlt.';
        return;
    }
    const form = document.getElementById('comfyui_wf_form');
    btn.disabled = true;
    btn.textContent = '⏳ rendert ...';
    statusEl.className = 'comfyui-wf-status';
    statusEl.textContent = 'Sammle Parameter ...';
    resultEl.innerHTML = '';
    try {
        const input = await collectFormInput(form, statusEl);
        // Persist non-image params
        const persist = { ...input };
        delete persist.input_image; // never persist a base64-blob
        if (!settings.params) settings.params = {};
        settings.params[workflow] = persist;
        saveSettings();

        statusEl.textContent = `POST /workflow/${workflow} (Render kann 5-180s dauern) ...`;
        const t0 = performance.now();
        // Track step-rate so we can show an ETA. Reset on each kind change.
        let lastProgressTs = 0;
        let lastProgressVal = 0;
        // node-id → display title (gefuellt vom prompt_meta SSE-Event)
        let nodeTitles = {};
        const niceNode = (id) => {
            if (!id) return '?';
            const t = nodeTitles[id];
            return t ? `${t} (#${id})` : `Node ${id}`;
        };
        const data = await generate(workflow, input, (kind, ev) => {
            if (kind === 'prompt_meta') {
                if (ev && ev.nodes && typeof ev.nodes === 'object') nodeTitles = ev.nodes;
            } else if (kind === 'queue') {
                const q = ev.pending ?? 0;
                statusEl.textContent = q > 0
                    ? `Warteschlange: ${q} Auftrag/Auftraege vor dir ...`
                    : 'Warteschlange leer — start gleich ...';
            } else if (kind === 'execution_start') {
                statusEl.textContent = 'Render gestartet ...';
                lastProgressTs = performance.now();
                lastProgressVal = 0;
            } else if (kind === 'executing') {
                statusEl.textContent = `▶ ${niceNode(ev.node)}`;
            } else if (kind === 'progress') {
                const v = ev.value ?? 0;
                const m = ev.max ?? 0;
                const pct = m > 0 ? Math.round((v / m) * 100) : 0;
                let eta = '';
                const now = performance.now();
                if (lastProgressTs && v > lastProgressVal && m > v) {
                    const dt = (now - lastProgressTs) / 1000;
                    const dv = v - lastProgressVal;
                    if (dv > 0 && dt > 0) {
                        const perStep = dt / dv;
                        const remaining = Math.round(perStep * (m - v));
                        eta = ` · ETA ${remaining}s (${perStep.toFixed(1)}s/it)`;
                    }
                }
                lastProgressTs = now;
                lastProgressVal = v;
                const nodePart = ev.node ? ` · ${niceNode(ev.node)}` : '';
                statusEl.textContent = `Step ${v}/${m} (${pct}%)${nodePart}${eta}`;
            } else if (kind === 'execution_success') {
                statusEl.textContent = 'Render fertig — lade Bild ...';
            } else if (kind === 'execution_error') {
                statusEl.textContent = `Render-Fehler: ${JSON.stringify(ev.error)?.slice(0, 200)}`;
            }
        });
        const t1 = performance.now();
        // Server-Plugin v0.4.0+ liefert {image: "user/images/..."} — die
        // base64-Konversion + saveBase64AsFile passiert bereits backend-side.
        // Fallback: aeltere Plugin-Version → {images: [base64]}, dann selbst saven.
        let imgSrc = data.image;
        if (!imgSrc && data.images?.length) {
            const meta = _workflowsMeta[workflow] || {};
            const ext = meta.output_format === 'webp' ? 'webp' : 'png';
            try {
                imgSrc = await saveBase64AsFile(data.images[0], 'comfyui-workflows', `${workflow}_${Date.now()}`, ext);
            } catch (saveErr) {
                console.warn(`[${MODULE_NAME}] saveBase64AsFile failed, falling back to data-URI:`, saveErr);
                imgSrc = `data:image/${ext};base64,${data.images[0]}`;
            }
        }
        if (imgSrc) {
            const img = new Image();
            img.className = 'comfyui-wf-thumb';
            img.src = imgSrc;
            resultEl.appendChild(img);
            statusEl.className = 'comfyui-wf-status success';
            statusEl.textContent = `OK — ${Math.round((t1 - t0) / 1000)}s client / ${data.stats?.total_time ?? '?'}ms server`;
        } else {
            statusEl.className = 'comfyui-wf-status error';
            statusEl.textContent = 'Keine Bilder in Response.';
        }
    } catch (e) {
        statusEl.className = 'comfyui-wf-status error';
        statusEl.textContent = `Fehler: ${e.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = '🎨 Generate';
    }
}

// ---------------------------------------------------------------------------
// Slash-Command Registrierung — `/sd-cw workflow=zimage prompt="..."`
// ---------------------------------------------------------------------------

function registerSlashCommand() {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument } = SillyTavern.libs || {};
        if (!SlashCommandParser) return;
        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sd-cw',
                callback: async (args, value) => {
                    const workflow = args.workflow || getSettings().workflow;
                    if (!workflow) return 'Kein Workflow.';
                    if (!_openapi) await loadAndPopulate({ classList: { add() { }, remove() { } }, textContent: '' });
                    const input = { ...((getSettings().params || {})[workflow] || {}) };
                    if (value) input.prompt = String(value);
                    if (args.negative_prompt) input.negative_prompt = String(args.negative_prompt);
                    if (args.seed) input.seed = parseInt(args.seed, 10);
                    if (args.steps) input.steps = parseInt(args.steps, 10);
                    const data = await generate(workflow, input);
                    return data.images?.[0] ? `[generated, ${data.images[0].length} chars base64]` : '[no image]';
                },
                helpString: 'Generate via ComfyUI Workflows. Args: workflow, seed, steps, negative_prompt. Unnamed = prompt.',
                returns: 'base64-png oder error-string',
                namedArgumentList: [],
                unnamedArgumentList: [],
            }),
        );
    } catch (e) {
        console.warn(`[${MODULE_NAME}] slash-command registration failed:`, e);
    }
}

// ---------------------------------------------------------------------------
// Init — UI ins Settings-Drawer haengen wenn ST initialisiert ist
// ---------------------------------------------------------------------------

async function init() {
    try {
        // Settings-HTML laden + ins #extensions_settings2-Panel haengen
        const settingsHtml = $(await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings'));
        const container = document.getElementById('extensions_settings2');
        if (!container) {
            console.error(`[${MODULE_NAME}] #extensions_settings2 container nicht gefunden — init abgebrochen`);
            return;
        }
        container.appendChild(settingsHtml[0]);

        // Test-Button — pingt Backend an + laedt Workflows
        document.getElementById('comfyui_wf_test').addEventListener('click', () => {
            loadAndPopulate(document.getElementById('comfyui_wf_test_status'));
        });

        // Workflow-Wechsel
        document.getElementById('comfyui_wf_workflow').addEventListener('change', rerenderForSelectedWorkflow);

        // Generate-Button
        document.getElementById('comfyui_wf_generate').addEventListener('click', generateClicked);

        // Slash-Command registrieren
        registerSlashCommand();

        console.log(`[${MODULE_NAME}] initialized (backend=${BACKEND_BASE})`);

        // Best-effort: workflows direkt laden (keep silent)
        loadAndPopulate(document.getElementById('comfyui_wf_test_status'))
            .catch(e => console.warn(`[${MODULE_NAME}] initial load failed:`, e));
    } catch (e) {
        console.error(`[${MODULE_NAME}] init failed:`, e);
    }
}

// Init-Trigger: jQuery-ready ist die robusteste Variante fuer ST-Extensions —
// ST laedt Extensions als ES Module nach DOM-Ready, und `jQuery(...)` mit
// einer Function feuert garantiert nach DOM-Init.
jQuery(async () => {
    // Wenn schon initialisiert (z.B. Hot-Reload): skip
    if (document.getElementById('comfyui_wf_settings')) return;
    await init();
});
