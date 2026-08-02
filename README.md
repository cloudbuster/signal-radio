# Signal — Radio

A small, static internet radio player. No backend, no account, no API keys.
Just static files and a browser `<audio>` element — nothing to build or
install to *deploy* it (see [Editing styles](#editing-styles) if you want to
*change* it).

Covers three free networks:

- **[SomaFM](https://somafm.com)** — catalog and now-playing fetched live
- **[Radio Browser](https://www.radio-browser.info)** — a hand-curated
  starter list (`data/radiobrowser.json`), plus live search to add more
- **[Yle](https://yle.fi)** — Finnish public radio (`data/yle.json`)

## Running it

There's nothing to build or install. Point any static file server at this
directory:

```sh
python3 -m http.server 8080
# or: npx serve .
# or: caddy file-server --listen :8080
# or: nginx/Apache with the document root set here
# or: tailscale serve 8080 (to keep it private to your tailnet)
```

Then open the served URL in a browser.

## Favourites and your own stations

Favourites and any stations you add via **+ BROWSE** are stored in your
browser's `localStorage`, not on a server. That means:

- They're private to you — other people visiting this same page won't see
  them, and they won't sync across your own devices either.
- Clearing site data / browser storage clears them too.

To add a station **for everyone** who uses this deployment, hand-edit
`data/radiobrowser.json` or `data/yle.json` and redeploy. Each entry looks
like:

```json
{
  "id": "some-unique-id",
  "name": "Station Name",
  "key": "some-unique-id",
  "item_type": "radio",
  "network": "radiobrowser",
  "description": "Genre · Country",
  "playlist_url": "https://example.com/stream"
}
```

Prefer an `https://` `playlist_url` when one exists. The page itself is served
over HTTPS, so an `http://` stream is mixed content: browsers either block it
outright or silently fail to autoupgrade it, which is also what trips the
"connection is not fully secure" warning some browsers show for this site.
Before adding a plain-http station, check whether swapping the scheme to
`https://` still connects (e.g. `curl -I https://host/path`) -- most Icecast
mirrors serve both.

## Editing styles

`tailwind.css` is a compiled, minified, purged stylesheet checked into the
repo — deploying the site never touches Tailwind's own tooling. If you add
or change utility classes in `index.html`/`app.js`, regenerate it:

```sh
npm install    # one-time, installs the Tailwind CLI locally
npm run build:css
```

This project deliberately doesn't load Tailwind's own CDN build
(`cdn.tailwindcss.com`) — that's a JIT compiler meant for prototyping
(~400KB of JS, recompiled in-browser on every page load, and Tailwind's own
docs say not to use it in production) rather than an actual stylesheet.

## Why there's no server

This started as a fork of
[audioaddict-cli-player](https://github.com/cloudbuster/audioaddict-cli-player),
which has a Python backend mainly to keep a paid DI.FM API key out of the
client and to aggregate a couple of catalog APIs. Dropping the paid network
entirely removed the one thing that genuinely needed a server: every
remaining catalog/search API here (`somafm.com`, `*.api.radio-browser.info`)
already sends permissive CORS headers, so the browser can just talk to them
directly.
