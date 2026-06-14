# Deploying Cykel to the VPS (cykel.health)

One origin serves both: the static landing at `/` and the PWA at `/app/`.
No build step — just rsync of `site/` and `pwa/`.

## Layout on the server
```
/var/www/cykel/
├── index.html, landing.css, landing.js, icon-*.png   ← from site/
└── app/
    └── index.html, app.js, sw.js, ...                ← from pwa/
```
The PWA uses relative paths, so it runs unchanged under `/app/`
(service-worker scope = `/app/`, manifest `start_url` = `./` = `/app/`).

## First-time server setup (run on the VPS)
```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/cykel
sudo chown -R "$USER":www-data /var/www/cykel

# DNS: point cykel.health (A) and www (A/CNAME) at the VPS IP first.

# Install the site config
sudo cp deploy/nginx.conf /etc/nginx/sites-available/cykel.health
sudo ln -sf /etc/nginx/sites-available/cykel.health /etc/nginx/sites-enabled/cykel.health
sudo rm -f /etc/nginx/sites-enabled/default

# TLS (edits the config in place and reloads)
sudo certbot --nginx -d cykel.health -d www.cykel.health
sudo nginx -t && sudo systemctl reload nginx
```

## Every deploy (run locally)
```bash
CYKEL_HOST=cykel.health CYKEL_USER=<you> ./deploy/deploy.sh
```
Bump `CACHE_NAME` in `pwa/sw.js` before deploying app changes so installed
clients fetch the new code.

## Verify
```bash
curl -sI https://cykel.health | grep -i -E 'strict-transport|content-security|referrer|permissions'
curl -sI https://cykel.health/app/ | grep -i content-security
```
Then load the site in a browser, confirm zero console errors, and install the
PWA from `/app/`.

## Notes
- This replaces the GitHub Pages / `gh-pages` flow — `cykel.health` is the
  single canonical origin.
- `nginx.conf` keeps security headers inherited across all locations by using
  `expires` (not `add_header`) for cache control. Don't add `add_header` inside
  a location or it will silently drop CSP/HSTS for that path.
