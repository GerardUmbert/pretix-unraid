# pretix on Unraid (throwaway test setup)

Unraid Docker template for running [pretix](https://pretix.eu/) — event
ticketing software — for **local testing only**. There is no official
Community Applications template for pretix, so this is a manually
installed template XML.

This uses pretix's own official `pretix/standalone:stable` image
unmodified, configured with SQLite instead of Postgres and no Redis/Celery
broker (pretix falls back to running background tasks inline when no
`[celery]`/`[redis]` section is present). No extra containers, no ports
beyond the web UI are exposed — nothing here touches other services
(Postgres, Redis, etc.) already running on the NAS.

**Not meant for production or long-term data.** For a real deployment,
follow pretix's official [self-hosting docs](https://docs.pretix.eu/self-hosting/),
which use the supported docker-compose stack (Postgres + Redis + pretix).

## Files

- `pretix-standalone.xml` — Unraid Docker template.
- `pretix.cfg` — pretix config file, mounted read-only into the container.

## How to run (Unraid)

1. Create the appdata folder and place `pretix.cfg` inside it:
   ```
   /mnt/user/appdata/pretix/pretix.cfg
   ```
2. Copy `pretix-standalone.xml` into Unraid's user-templates folder:
   ```
   /boot/config/plugins/dockerMan/templates-user/pretix-standalone.xml
   ```
3. Docker tab → Add Container → select the **pretix** template.
   Check the web UI port (default `8345`) doesn't collide with anything
   else, then Apply.
4. First boot runs database migrations (~30-60s). Once up, the UI is at:
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
docker run -d --name pretix \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/pretix.cfg:/etc/pretix/pretix.cfg:ro" \
  -p 8345:80 \
  pretix/standalone:stable all
```

Then visit `http://localhost:8345/control/` and create a superuser the
same way as above.

## Tearing it down

Remove the container and delete the appdata/data folder
(`/mnt/user/appdata/pretix/` on Unraid, or `./data` locally) — SQLite
means everything lives in that one folder, nothing else to clean up.
