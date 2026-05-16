# st-comfyui-workflows — SillyTavern Extension for self-hosted ComfyUI

A SillyTavern third-party extension that talks to a self-hosted
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) backend wrapped by
[SaladTechnologies/comfyui-api](https://github.com/SaladTechnologies/comfyui-api).

It discovers workflows + their parameter schemas dynamically and renders
a tailored form per workflow. No baked-in workflow assumptions — works
with whatever the backend exposes.

## Architecture (v0.3.0+)

Browser-extension ↔ ComfyUI now goes through the **SillyTavern backend**
instead of fetching directly from the browser. This eliminates CORS
complexity, allows the ComfyUI backend to live on a private network
(Tailscale, VPN, Docker-internal), and produces a single central log in
the SillyTavern container.

```
SillyTavern Browser-UI                 SillyTavern Backend (Node.js)             ComfyUI-API
       │                                       │                                       │
       │ POST /api/plugins/st-ext-server-loader/ext/                                  │
       │      st-comfyui-workflows/workflow/<name>                                    │
       │ ──────────────────────────────────────► │                                    │
       │                                       │ POST $COMFYUI_BASE_URL/workflow/...  │
       │                                       │ ──────────────────────────────────►  │
       │                                       │ ◄────────── {images: [base64]} ──── │
       │ ◄──────────── {images: [base64]} ──── │                                      │
```

## Required: st-ext-server-loader

This extension ships server-side code in a `server/` subdirectory. To
load it, the SillyTavern instance must have the
[**st-ext-server-loader**](https://github.com/rostchri/st-ext-server-loader)
server-plugin installed and `enableServerPlugins: true` in its config.

**One-time setup per SillyTavern instance:**

1. Put `st-ext-server-loader` into SillyTavern's `plugins/` directory:
   ```
   /home/node/app/plugins/st-ext-server-loader/
   ├── package.json
   └── index.js
   ```
2. Enable plugins: set `SILLYTAVERN_ENABLESERVERPLUGINS=true` (env-var)
   or `enableServerPlugins: true` in `config.yaml`.
3. Set the upstream URL: `COMFYUI_BASE_URL=http://your-comfyui-host:3000`
4. Restart the SillyTavern container.

You only do this **once per ST instance**. After that, any extension
which ships a `server/` folder (like this one) is auto-loaded — no
further container changes for additional extensions.

## Features

- **Settings drawer section** with:
  - Test button (pings the backend + populates the workflow list)
  - Workflow dropdown (auto-populated from `/workflows-meta`)
  - Workflow card with display name, description, tags, category,
    estimated render time, output format
  - **Dynamic parameter form** generated from the OpenAPI schema
    (text, number, enum, boolean, nested objects for things like group toggles)
  - **I2I file picker** with auto-JPEG conversion (PNG data-URIs are
    known to be corrupted by `comfyui-api` v1.17.1)
  - **"Use char avatar"** button — uses the currently selected
    SillyTavern character's avatar as the I2I input
  - Generate button + result thumbnail
- **Slash-command** `/sd-cw workflow=<name> prompt="..."` for
  programmatic invocation (slot it into Quick Replies, Lorebooks, etc.)
- **Per-workflow parameter persistence** in
  `extensionSettings.comfyui_workflows.params`

## Installation

### Via SillyTavern Extension Manager (recommended)

1. Make sure [**st-ext-server-loader**](https://github.com/rostchri/st-ext-server-loader)
   is installed in the ST container (see *Required* section above).
2. Open SillyTavern → Extensions toolbar icon (stacked cards)
3. **"Manage extensions"** → **"Install extension"**
4. URL:
   ```
   https://github.com/rostchri/st-comfyui-workflows
   ```
5. Install → **restart the SillyTavern container** (server-side `init()`
   only runs at container startup)
6. Reload the browser tab → extension shows up as **"ComfyUI Workflows"**

### Manual

```sh
cd <SillyTavern-root>/public/scripts/extensions/third-party
git clone https://github.com/rostchri/st-comfyui-workflows.git
# Restart the ST container
```

## Backend requirements

The upstream `comfyui-api` instance (pointed to by `COMFYUI_BASE_URL` on
the SillyTavern container) must expose these endpoints (all under the
configured base URL):

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `GET /docs/json` | OpenAPI 3.0 schema for all workflows |
| `GET /workflows-meta` | Per-workflow metadata (see below) |
| `POST /workflow/<name>` | Render — body `{input: {...}}`, response `{images: [base64], stats: {...}}` |

### `workflows-meta` response format

```json
{
  "workflows": {
    "<workflow-name>": {
      "category": "t2i" | "i2i" | "t2v" | "upscale" | "debug",
      "output_format": "png" | "webp" | "mp4" | "jpeg",
      "display_name": "Human-Friendly Title",
      "description": "1-sentence description for tooltip / card",
      "requires_image_input": true | false,
      "estimated_seconds_p50": 60,
      "tags": ["sdxl", "i2i", "edit"],
      "param_visibility": {
        "primary":  ["prompt", "input_image"],
        "advanced": ["cfg", "sampler", "seed"]
      }
    }
  }
}
```

A reference implementation of this endpoint as a ComfyUI custom-node
sits in `custom_nodes/comfyui-api-proxy/` of the companion infra repo —
~150 LOC Python, aiohttp routes.

## Conventions

- **I2I input field** is always named `input_image` (string, data-URI or HTTP URL)
- Prefer **JPEG data-URIs** for I2I inputs — PNG data-URIs are corrupted by
  `comfyui-api` v1.17.1 on disk write (known upstream bug, no workaround
  needed if you use JPEG)
- Output is always `images[0]` as base64 — MIME is taken from
  `output_format` in the workflow's meta (defaults to PNG)

## Slash-command

```
/sd-cw workflow=zimage seed=42 steps=4 "a cat in a hat"
```

Arguments:
- `workflow` (named) — overrides the dropdown selection for this call
- `seed` / `steps` / `negative_prompt` (named) — override the persisted values
- unnamed value — becomes `prompt`

## Development

```sh
git clone https://github.com/rostchri/st-comfyui-workflows
cd st-comfyui-workflows
# edit files
# bump manifest.json version
# commit + push
```

In ST: "Manage extensions" → click the update arrow next to your install.
**Then restart the ST container** if you changed anything under `server/`.

## License

MIT — see [LICENSE](LICENSE).
