# Zeltcon Checker

A dark, high-contrast temporary email & instant OTP verification engine with an editorial aesthetic inspired by Lorenzo Lottici and interactive Three.js 3D kinetic geometry.
Backed by high-speed Node.js and Python servers with zero external npm dependencies.

Receives genuine email/OTP dispatches — not a simulated demo. Local web dashboard + CLI.

## Quick Run

```bash
cd ~/Desktop/custommails
./run.sh              # Starts Zeltcon Checker at http://127.0.0.1:8788
```

- **Main Dashboard**: [http://127.0.0.1:8788/](http://127.0.0.1:8788/)
- **Fernhollow 3D Flower Valley Hero**: [http://127.0.0.1:8788/fernhollow](http://127.0.0.1:8788/fernhollow)
- **Fernhollow 100% Inlined Standalone**: [http://127.0.0.1:8788/fernhollow-standalone](http://127.0.0.1:8788/fernhollow-standalone)

Or run via Node.js or Python directly:

```bash
# Node.js
npm start            # or: node server.js

# Python
python3 web.py
```

1. Pick a domain (loaded live from the API) or leave "Random Domain".
2. Click **Create Inbox** or hit **⚡** for an instant random mailbox.
3. Use that address wherever you need (signup/OTP).
4. Watch the **Inbox** tab; click **Refresh**, or enable **auto-refresh** (polls every 8s).
5. OTP codes are automatically detected and highlighted with a 1-click **Copy Code** hero banner.
6. Check the **Spam** tab if messages are filtered.

**Password**: Click **🔑** in the active toolbar to reveal the mailbox password, or open **↗** to log into webmail.

## Key Features & Polish (/unslop)

- **Interactive 3D Kinetic Prism**: Real-time Three.js geometric prism that reacts smoothly to cursor physics and pulses on mail activity. Zero bloat, throttles gracefully when backgrounded.
- **Dual Server Engines (Node.js & Python)**: Complete zero-dependency Node.js server (`server.js`) and standard Python 3 server (`web.py`).
- **Attractive Message Template**:
  - High-contrast, legible typography with proper line-height and auto-hyperlinked URLs.
  - Dedicated **Verification Code (OTP) Hero Card** with monospaced digits and tactile 1-click copy with instant visual checkmark.
  - In-list OTP detection chips so you can copy verification codes directly without waiting for full emails to open.
  - Tabbed Rich HTML view vs Clean Plain Text view.
  - Iframe security sandbox configured with `allow-popups` so verification links open properly in new tabs.
  - Attachment cards with format icons, file sizes, and 1-click download.
- **Zero Glitches**:
  - Fully responsive mobile drawer and "← Back to messages" navigation on narrow viewports.
  - Asynchronous race condition prevention.
  - Unblocked background auto-refresh that doesn't freeze when an email is open.
  - Stored mailbox persistence in `localStorage`.
  - Power-user keyboard shortcuts (`J`/`K` navigation, `C` copy address, `R` refresh, `/` search, `Esc` back).
  the app fetches the complete message over **IMAP** (`mail.galaxium.art:993`, same mailbox
  password) and renders it properly in a sandboxed frame.
- The verification code is auto-extracted (the `code-text` block, or digits next to
  "code/OTP/verification") and shown in a big **copy** banner at the top of the message.

## API surface used

| Feature | Endpoint |
|---------|----------|
| domains | `GET /v1/domains` |
| create inbox | `POST /v1/inbox/create` `{domain, local_part}` |
| list inbox | `POST /v1/inbox` `{email, password, page, per_page}` |
| list spam | `POST /v1/spam` |
| read message | `POST /v1/message` `{email, password, id}` |
| read spam message | `POST /v1/spam/message` |
| search | `POST /v1/search` `{email, password, query, ...}` |
| attachment | `POST /v1/attachment` `{email, password, id, attachment_index}` |
| count / key age / uptime | `POST /v1/count`, `GET /v1/key/age`, `GET /v1/uptime` |

`page` is 0-based; `per_page` is 1–25 (default 10). Rate limit is 30 requests/min per key
and 4 inbox creations/min, so auto-refresh is set to 8s.

## CLI

```bash
python3 cli.py health
python3 cli.py meta                  # mailbox count, key age, uptime
python3 cli.py domains
python3 cli.py new --domain galaxium.art --name myname
python3 cli.py inboxes
python3 cli.py list  you@galaxium.art --page 0 --per-page 10
python3 cli.py list  you@galaxium.art --spam
python3 cli.py read  you@galaxium.art <id>
python3 cli.py search you@galaxium.art otp
python3 cli.py attach you@galaxium.art <id> 0 -o file.pdf
python3 cli.py reveal you@galaxium.art      # show password / webmail
python3 cli.py forget you@galaxium.art      # remove from local store
```

## Config (`config.json`)

```json
{
  "base_url": "https://api.galaxium.art",
  "api_key": "YOUR_KEY",
  "auth": { "header": "Authorization", "prefix": "Bearer " },
  "timeout": 30,
  "inbox_store": "inboxes.json",
  "imap_port": 993,
  "hide_domains": ["rape", "loliporn", "nigger", "foid", "mcvirgins", "killall", "mossad", "getfucked"]
}
```

- `imap_host` is optional; it defaults to the mailbox webmail host (`mail.galaxium.art`).
  `imap_port` defaults to `993` (SSL).

- The key needs **Premium** on the Galaxium Discord. If it's rejected, regenerate it from
  the Discord API panel.
- `hide_domains` filters abusive domain names out of the picker.
- A desktop browser `User-Agent` is sent because Cloudflare rejects the default Python UA.

## Files

| File | Purpose |
|------|---------|
| `galaxium.py` | API client + local credential store |
| `web.py` | local web server + API proxy |
| `index.html` | dashboard UI |
| `cli.py` | command-line client |
| `config.json` | API key + settings |
| `inboxes.json` | created mailboxes (contains passwords — private) |
| `run.sh` | launcher |

## Troubleshooting

- **`premium_required` / `invalid_api_key`** — key not premium or rotated; regenerate it.
- **`mailbox_authentication_failed`** — stored password wrong; the mailbox may have been
  created under a different key. Create a new inbox.
- **`rate_limited` (429)** — slow down; wait `Retry-After` seconds.
- **`domain_unavailable`** — pick another domain.
- **Mail not arriving** — confirm the sending site accepted the address, wait a few
  seconds, Refresh, and check the Spam tab.
