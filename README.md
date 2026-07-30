# ☁️ My Cloud

A lightweight, self-hosted file sharing platform in the spirit of **Nextcloud / ownCloud** — but with **zero database setup**. Built for Unraid and other home servers, aimed at people who don't have a ton of files and don't want to babysit MySQL or Postgres.

Everything is stored as plain files:

- **Your files** stay as ordinary files on disk (`/data/users/<username>/files`) — browse them with any other tool, back them up with rsync, nothing is locked inside a database blob.
- **App state** (users, share links, settings) is a handful of small JSON files in `/config`.

## Features

- 🔐 **Multi-user accounts** — admin-managed users with bcrypt-hashed passwords, per-user storage quotas, and isolated home folders
- 📁 **Fast web file browser** — grid & list views, breadcrumbs, multi-select (Ctrl/Shift-click), rename, move, copy, new folders
- ⬆️ **Drag & drop uploads** — multiple files and whole folders, with a live progress bar; quota enforced server-side
- 👁 **Previews** — images, video and audio (with seeking), PDFs, and text/code files
- ✏️ **Built-in text editor** — edit notes, configs, and markdown right in the browser
- 🔗 **Public share links** — share any file or folder with a link; optional password, optional expiry, and optional "drop box" mode letting visitors upload into a shared folder
- 🗑 **Trash bin** — deletes go to trash first, with restore and configurable auto-purge
- 🔍 **Search** — instant filename search across your whole home folder
- 📦 **Zip downloads** — download any folder or multi-selection as a zip, streamed on the fly
- 📱 **Responsive UI** — works nicely on phones, with automatic light/dark theme
- 🧳 **First-run setup** — open the web UI once and create your admin account; that's it

## Quick start (Unraid)

1. Copy `templates/my-cloud.xml` into `/boot/config/plugins/dockerMan/templates-user/` — save it as `my-My-Cloud.xml` (Unraid strips the `my-` filename prefix to label user templates in the Add Container dropdown). Or install from Community Applications once published.

   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-My-Cloud.xml \
     https://raw.githubusercontent.com/evilgenius79/My-Cloud/main/templates/my-cloud.xml
   ```
2. Map:
   - **`/config`** → `/mnt/user/appdata/my-cloud` (settings, users, shares)
   - **`/data`** → `/mnt/user/my-cloud` (where user files live)
   - **Port** `8686` → any free host port
3. Start the container, open `http://your-server:8686`, and create the first admin account.

## Quick start (Docker / docker-compose)

```bash
git clone https://github.com/evilgenius79/My-Cloud.git
cd My-Cloud
docker compose up -d --build
# open http://localhost:8686
```

## Quick start (bare Node.js)

Requires Node 18+.

```bash
npm install
npm run dev        # stores state in ./dev-config and ./dev-data
# open http://localhost:8686
```

## Configuration

| Environment variable  | Default   | Purpose                                  |
| --------------------- | --------- | ---------------------------------------- |
| `MYCLOUD_CONFIG_DIR`  | `/config` | Settings, users, shares, session secret  |
| `MYCLOUD_DATA_DIR`    | `/data`   | User files (`users/<name>/files`)        |
| `MYCLOUD_PORT`        | `8686`    | HTTP port                                |

Runtime settings (site name, default quota, trash retention) are editable from the **Admin** page in the UI.

## How data is laid out

```
/config
  settings.json       # site settings
  users.json          # accounts (passwords bcrypt-hashed)
  shares.json         # public share links
  secret.key          # session-signing secret (keep private)

/data
  users/
    alice/
      files/          # alice's files — plain files, nothing special
      trash/          # deleted items + small .meta.json sidecars
```

Backing up My Cloud = backing up those two folders. Restoring = putting them back. There is no database to dump, migrate, or repair.

## Security notes

- Passwords are stored bcrypt-hashed; sessions are HMAC-signed HTTP-only cookies.
- Login attempts are rate-limited per IP.
- All file paths are validated server-side against directory traversal.
- **Use HTTPS** if you expose this to the internet — put it behind a reverse proxy (Nginx Proxy Manager, SWAG, Traefik, Caddy) with a TLS certificate. Cookies are `SameSite=Lax`/`HttpOnly` but only as safe as the transport.

## Roadmap ideas

- WebDAV endpoint for desktop sync clients
- Server-generated thumbnails for large photo folders
- Share links for multiple selections
- Activity log

PRs welcome.

## License

MIT
