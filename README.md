# WiseTech Image MCP Server

An MCP (Model Context Protocol) server that exposes **all three** WiseTech AI image tools to any MCP-compatible client (Claude, ChatGPT, Grok, etc.):

| Tool | What it does | API endpoint |
|------|-------------|-------------|
| `upscale_image` | Upscales an image to higher resolution | `{main_api}/upscale_web_v2` |
| `enhance_face` | Enhances faces in an image | `{main_api}/faceenhance_web` |
| `remove_background` | Removes the background from an image | `{bg_api}/uploadImageV2` → `/processImageBackgroundRemove` → `/getStatus` → `/downloadImage` |

All three accept a **public image URL** and return the processed image as **base64 PNG**.

**Verified working** — all three APIs tested end-to-end on 2026-06-20.

---

## Quick start (local testing)

```bash
npm install
npm run dev
```

Server starts on `http://localhost:3000/mcp`. No `.env` needed for local testing — it auto-resolves the API URLs.

---

## Environment variables

All config lives in `.env` (never committed to git). Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_KEY` | **Yes for production** | Your secret key. Clients send `Authorization: Bearer <key>`. Generate with `openssl rand -hex 32`. |
| `WISETECH_MAIN_DNS` | No | DNS resolver URL for main API (default: `https://sd.rad-wi.com`) |
| `WISETECH_BG_DNS` | No | DNS resolver URL for bg remover API (default: `https://ibgc.rad-wi.com/`) |
| `WISETECH_MAIN_FALLBACK` | No | Fallback main API IP if DNS fails |
| `WISETECH_BG_FALLBACK` | No | Fallback bg API IP if DNS fails |
| `WISETECH_MAIN_API_URL` | No | Pin a specific main API host (skips DNS) |
| `WISETECH_BG_API_URL` | No | Pin a specific bg API host (skips DNS) |
| `WISETECH_API_KEY` | No | API key if WiseTech adds one (currently not needed) |
| `WISETECH_AUTH_HEADER` | No | Header name for the API key (e.g. `x-api-key`) |
| `PORT` | No | HTTP port (default: `3000`, Heroku sets this automatically) |

### DNS auto-refresh

The WiseTech API IPs rotate daily. This server replicates the WordPress plugin's DNS-resolution: on startup (and every 6 hours) it fetches the current URL from the DNS endpoints. No manual IP updates needed.

---

## Deploy on Heroku

### Step 1: Install Heroku CLI and login

```bash
npm install -g heroku
heroku login
```

### Step 2: Create a Heroku app

```bash
cd wisetech-image-mcp
heroku create wisetech-image-mcp
```

### Step 3: Set environment variables

```bash
# Generate a strong auth key
heroku config:set MCP_AUTH_KEY=$(openssl rand -hex 32)

# API URLs (auto-resolved from DNS, but set fallbacks)
heroku config:set WISETECH_MAIN_DNS=https://sd.rad-wi.com
heroku config:set WISETECH_BG_DNS=https://ibgc.rad-wi.com/
heroku config:set WISETECH_MAIN_FALLBACK=http://34.232.100.156:5454
heroku config:set WISETECH_BG_FALLBACK=http://35.190.164.209:5454
```

### Step 4: Deploy

```bash
git add .
git commit -m "Initial deploy"
git push heroku main
```

Heroku automatically:
- Runs `npm install`
- Runs `npm run build` (via the `build` script in `package.json`)
- Starts the app using the `Procfile`: `web: node dist/index.js`
- Assigns a port via the `PORT` env var (handled automatically)

### Step 5: Verify it's running

```bash
heroku open
# Or test the MCP endpoint:
curl -X POST https://wisetech-image-mcp.herokuapp.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_MCP_AUTH_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see all three tools in the response.

### Step 6: Connect to AI tools

Your MCP URL is: `https://wisetech-image-mcp.herokuapp.com/mcp`

Use this URL + your `MCP_AUTH_KEY` in Claude / ChatGPT / Grok (see below).

### Heroku notes

- **Free tier sleeps** after 30 min of inactivity. First request after sleep takes ~10s to wake up. Use `heroku ps:scale web=1` and consider upgrading to Eco/Hobby for always-on.
- **Port**: Heroku sets `PORT` automatically — don't set it yourself.
- **Timeout**: Heroku has a 30s request timeout on free tier. Image processing can take up to 180s. If you hit timeouts, upgrade to Hobby tier or use a VPS instead.

---

## Deploy on a VPS (recommended for production)

VPS is better than Heroku for this because image processing can take up to 3 minutes (Heroku free tier times out at 30s).

### Step 1: Upload the code

```bash
# On your VPS
git clone <your-repo-url> /opt/wisetech-mcp
cd /opt/wisetech-mcp
npm install
npm run build
```

### Step 2: Create the `.env` file

```bash
nano /opt/wisetech-mcp/.env
```

```env
MCP_AUTH_KEY=your-strong-random-key-here
WISETECH_MAIN_DNS=https://sd.rad-wi.com
WISETECH_BG_DNS=https://ibgc.rad-wi.com/
WISETECH_MAIN_FALLBACK=http://34.232.100.156:5454
WISETECH_BG_FALLBACK=http://35.190.164.209:5454
WISETECH_API_KEY=
WISETECH_AUTH_HEADER=
PORT=3000
```

Generate a strong key:
```bash
openssl rand -hex 32
```

### Step 3: Lock down `.env`

```bash
chmod 600 /opt/wisetech-mcp/.env
chown root:root /opt/wisetech-mcp/.env
```

### Step 4: Run as a systemd service (stays alive after reboot)

```bash
nano /etc/systemd/system/wisetech-mcp.service
```

```ini
[Unit]
Description=WiseTech Image MCP Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/wisetech-mcp
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/wisetech-mcp/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable wisetech-mcp
systemctl start wisetech-mcp
systemctl status wisetech-mcp    # should say "active (running)"
```

### Step 5: Add HTTPS with nginx (required for AI tools)

AI tools like Claude/ChatGPT require HTTPS URLs. Use nginx + Let's Encrypt (free SSL).

```bash
apt install nginx certbot python3-certbot-nginx -y
```

```bash
nano /etc/nginx/sites-available/wisetech-mcp
```

```nginx
server {
    server_name your-domain.com;

    location /mcp {
        proxy_pass http://127.0.0.1:3000/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 300s;
        client_max_body_size 20m;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/wisetech-mcp /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
certbot --nginx -d your-domain.com
```

### Step 6: Verify

```bash
curl -X POST https://your-domain.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_MCP_AUTH_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Your MCP URL is: `https://your-domain.com/mcp`

---

## Connecting to AI tools

### Claude Desktop

Edit this file:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "wisetech-image": {
      "url": "https://your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see three tools available:
- `upscale_image`
- `enhance_face`
- `remove_background`

### ChatGPT / Grok / other MCP clients

Go to their custom tools / MCP settings and add:
- **URL:** `https://your-domain.com/mcp`
- **Header:** `Authorization: Bearer YOUR_MCP_AUTH_KEY`

### Local testing (no deployment needed)

```bash
npm run dev
```

Point your AI client at `http://localhost:3000/mcp` (no auth key needed for local).

---

## How it works

### Upscale & Face Enhance (synchronous)

```
User → AI tool → MCP server → downloads image from URL → base64-encodes →
  POST {main_api}/upscale_web_v2   (or /faceenhance_web)
  body: {"image": "<base64>"}
  → response: {"image": "<base64 result>"}
→ returns base64 PNG to the AI tool → AI tool shows it to the user
```

### Background Remover (asynchronous, handled automatically)

```
User → AI tool → MCP server → downloads image →
  1. POST  {bg_api}/uploadImageV2            (multipart "file")
  2. GET   {bg_api}/processImageBackgroundRemove?imageName=...
  3. Poll  {bg_api}/getStatus?imageName=...   (every 3s until status=1)
  4. GET   {bg_api}/downloadImage?imageName=...png
→ returns base64 PNG to the AI tool
```

The entire async flow is hidden from the AI tool — it just gets the final image back.

---

## Supported formats

| Tool | Formats |
|------|---------|
| Upscale | JPG, JPEG, PNG, GIF, JFIF, WEBP, BMP, ICO, SVG, AVIF |
| Face Enhance | JPG, JPEG, PNG, GIF, JFIF, WEBP, BMP, ICO, SVG, AVIF |
| Background Remove | JPG, JPEG, PNG, WEBP, JFIF, BMP |

**Max file size:** 10 MB (enforced server-side, matching the WP plugin).

---

## Project structure

```
wisetech-image-mcp/
├── index.ts          # MCP server — all 3 tools
├── package.json      # Dependencies + scripts
├── tsconfig.json     # TypeScript config
├── Procfile          # Heroku deployment config
├── .env              # Your secrets (NEVER commit to git)
├── .env.example      # Template for .env
├── .gitignore        # Blocks .env, SECURITY.md, node_modules from git
├── SECURITY.md       # Security & deployment details (kept private)
├── README.md         # This file
└── Extra_Just_For_API_Info/   # Original PHP plugin reference code
```

---

## Notes

- The server uses **Streamable HTTP transport** (not stdio), so it works with remote/web-based MCP clients like ChatGPT and Grok, not just Claude Desktop.
- Background removal output is always PNG (the API converts the input filename to `.png`).
- All API URLs are in `.env`, not in the code — someone reading the source sees nothing.
- See `SECURITY.md` for detailed security information and hardening steps.