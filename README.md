# st-comfyui-workflows — SillyTavern Extension for self-hosted ComfyUI

A SillyTavern third-party extension that talks to a self-hosted
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) backend wrapped by
[SaladTechnologies/comfyui-api](https://github.com/SaladTechnologies/comfyui-api).

It discovers workflows + their parameter schemas dynamically and renders
a tailored form per workflow. No baked-in workflow assumptions — works
with whatever the backend exposes.

## Features

- **Settings drawer section** with:
  - Base-URL input (default placeholder; set to your own backend)
  - "Test + load workflows" button
  - Workflow dropdown (auto-populated from `/api-proxy/workflows-meta`)
  - Workflow card with display name, description, tags, category, estimated render time, output format
  - **Dynamic parameter form** generated from the OpenAPI schema
    (text, number, enum, boolean, nested objects for things like group toggles)
  - **I2I file picker** with auto-JPEG conversion (PNG data-URIs are known to
    be corrupted by `comfyui-api` v1.17.1)
  - **"Use char avatar"** button — uses the currently selected SillyTavern
    character's avatar as the I2I input
  - Generate button + result thumbnail
- **Slash-command** `/sd-cw workflow=<name> prompt="..."` for programmatic invocation
  (slot it into Quick Replies, Lorebooks, etc.)
- **Per-workflow parameter persistence** in `extensionSettings.comfyui_workflows.params`
- SSO-friendly (browser fetch uses `credentials: 'include'`)

## Installation

### Via SillyTavern Extension Manager (recommended)

1. Open SillyTavern → Extensions toolbar icon (stacked cards)
2. **"Manage extensions"** → **"Install extension"**
3. URL:
   ```
   https://github.com/rostchri/st-comfyui-workflows
   ```
4. Install → reload the browser tab
5. Extension shows up as **"ComfyUI Workflows"** in the settings drawer

### Manual

```sh
cd <SillyTavern-root>/public/scripts/extensions/third-party
git clone https://github.com/rostchri/st-comfyui-workflows.git
```

## Setup

1. In the extension settings, set **Base-URL** to your ComfyUI backend
   (e.g. `https://comfyui.example.com/api-proxy` if you use a TLS reverse proxy,
   or `http://your-host:8188/api-proxy` for direct LAN access)
2. Click **"Test + load workflows"** — populates the dropdown
3. Pick a workflow, fill in parameters, hit **Generate**

If the backend sits behind cookie-based SSO (Authelia, oauth2-proxy, etc.):
- Visit the backend host once in a browser tab so the SSO cookie is set
- Since the extension uses `credentials: 'include'`, cookies on the parent
  domain (`example.com`) are sent on cross-subdomain XHRs

## Backend requirements

The backend must expose these endpoints (all under `<base_url>`):

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

## CORS / Auth notes

If the browser and backend are on different origins:
- Start ComfyUI with `--enable-cors-header https://<your-st-host>`
- The proxy `api-proxy` custom-node adds `Access-Control-Allow-Credentials: true`
  and reflects the specific Origin when it matches a configured suffix
- For preflight (OPTIONS) to work without auth challenge, route OPTIONS
  around your auth proxy. With Traefik this is a one-line rule:
  `Host(\`comfyui.example.com\`) && Method(\`OPTIONS\`)` with no auth
  middleware in the chain.

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

## License

MIT — see [LICENSE](LICENSE).
