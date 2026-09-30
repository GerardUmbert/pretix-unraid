# pretix on Unraid (throwaway test setup)

Unraid Docker template for running [pretix](https://pretix.eu/) — event
ticketing software — for **local testing only**. There is no official
Community Applications template for pretix, so this is a manually
installed template XML.

This builds on top of pretix's own official `pretix/standalone:stable`
image, configured with SQLite instead of Postgres and no Redis/Celery
broker (pretix falls back to running background tasks inline when no
`[celery]`/`[redis]` section is present). No extra containers, no ports
beyond the web UI are exposed — nothing here touches other services
(Postgres, Redis, etc.) already running on the NAS.

On top of the stock image, this repo adds a thin `Dockerfile` +
`docker-entrypoint-plugins.sh` that can install extra pretix plugins
(pip packages) at container start via the `PRETIX_PLUGINS` env var —
see "Installing extra plugins" below. With `PRETIX_PLUGINS` unset, the
container behaves identically to the stock image.

**Not meant for production or long-term data.** For a real deployment,
follow pretix's official [self-hosting docs](https://docs.pretix.eu/self-hosting/),
which use the supported docker-compose stack (Postgres + Redis + pretix).

## Files

- `Dockerfile` — builds the custom image on top of `pretix/standalone:stable`.
- `docker-entrypoint-plugins.sh` — first-boot plugin installer, see below.
- `.github/workflows/build-image.yml` — GitHub Actions workflow that
  builds this Dockerfile and pushes it to GHCR (GitHub Container
  Registry) on every push to `master` that touches the Dockerfile or
  entrypoint script.
- `my-pretix-standalone.xml` — Unraid Docker template.
- `pretix.cfg` — optional pretix config file, used only by the local
  dev scripts. The image itself needs no config file: SQLite and the data
  path are built in, and the public URL comes from the
  `PRETIX_PRETIX_URL` env var (a field in the Unraid template).

## Building and publishing the image

Unraid pulls images by name from a registry — it can't run `docker build`
itself. This repo's image is built and published via GitHub Actions:

1. Push this repo to GitHub (if not already).
2. The workflow in `.github/workflows/build-image.yml` runs automatically
   on push to `master`, building and pushing to
   `ghcr.io/<your-github-username>/pretix-custom:latest`.
3. First time only: on GitHub, go to the pushed package's settings (under
   your profile → Packages → pretix-custom) and make sure its visibility
   matches what you want (public, or private + linked to this repo so
   your NAS can pull it — private GHCR packages need a PAT for `docker
   login` on the Unraid side).
4. `my-pretix-standalone.xml`'s `<Repository>`, `<Registry>` and
   `<TemplateURL>` already point at `GerardUmbert`'s GHCR/GitHub. If you
   fork this, change them to your own username.

You can also build and run it fully locally without any registry, e.g.
for testing changes to the Dockerfile before pushing:

```sh
docker build -t pretix-custom:local .
docker run -d --name pretix-test \
  -v pretix_test_data:/data \
  -e PRETIX_PRETIX_URL=http://localhost:18345 \
  -p 18345:8345 \
  pretix-custom:local
```

## Installing extra plugins

Set the `PRETIX_PLUGINS` environment variable to a comma-separated list
of pip package names, e.g. `pretix-passbook,pretix-someplugin`. On
container start, `docker-entrypoint-plugins.sh` installs each one, runs
migrations, and rebuilds static assets before pretix itself starts.
Leave it unset (default) to run the stock feature set with no extra
install step.

To change the plugin list later: edit the `Extra Plugins` field in the
Unraid template and restart the container — no image rebuild needed,
since the install happens at container start, not build time.

## How to run (Unraid)

No config file is needed — the image has SQLite and `/data` built in.

1. Copy `my-pretix-standalone.xml` into Unraid's user-templates folder:
   ```
   /boot/config/plugins/dockerMan/templates-user/my-pretix-standalone.xml
   ```
2. Docker tab → Add Container → select the **pretix** template.
   Check the web UI port (default `8345`) doesn't collide with anything
   else.
3. Set **Public URL** to the address you will actually browse to, since
   pretix builds links and CSRF/cookie checks from it and login breaks
   if it doesn't match:
   - LAN: `http://<nas-ip>:8345`
   - Cloudflare Tunnel: the tunnel's `https://` hostname (point the
     tunnel's service at `http://<nas-ip>:8345`). Only one URL is
     supported, so LAN access to the UI won't work cleanly alongside it.
     Consider Cloudflare Access in front, since this is a throwaway
     instance with no hardening.

   Then Apply. To change it later, edit the field and restart the
   container — no rebuild needed.
4. First boot runs database migrations (~30-60s), plus plugin install if
   `PRETIX_PLUGINS` is set. Once up, the UI is at:
   ```
   http://<nas-ip>:8345/control/
   ```
5. Create an admin user:
   ```
   docker exec -it pretix python3 -m pretix createsuperuser
   ```

## How to run (plain Docker, no Unraid)

```sh
mkdir -p ./data
docker build -t pretix-custom:local .
docker run -d --name pretix \
  -v "$(pwd)/data:/data" \
  -e PRETIX_PRETIX_URL=http://localhost:8345 \
  -p 8345:8345 \
  pretix-custom:local
```

Then visit `http://localhost:8345/control/` and create a superuser the
same way as above.

## Tearing it down

Remove the container and delete the appdata/data folder
(`/mnt/user/appdata/pretix/` on Unraid, or `./data` locally) — SQLite
means everything lives in that one folder, nothing else to clean up.
