# Jackettio

Selfhosted Stremio addon that resolve streams using Jackett and Debrid. It seamlessly integrates with private trackers.

## Features

- Resolve streams using Jackett and Debrid (debrid-link, alldebrid, real-debrid, premiumize, torbox)
- **TorBox Downloads catalog** — browse your TorBox account's completed downloads (movies & TV) directly in Stremio and play any file (shown when TorBox is the selected debrid). Posters are matched via Cinemeta/TMDB, with a generated title poster as a fallback. Series downloads also appear under a dedicated **series** catalog, where opening an item lists every episode file as a stream
- **Series support in search** — a Stremio search also surfaces a **series** results row (season/episode torrents), alongside the movie row; each result plays its sources through TorBox just like movies
- **Latest added 4k (3d / 1w) catalogs** — a Jackett "4k" search filtered to torrents published in the last 3 days / 1 week, sorted by size; same-title sources are grouped into one item and offered as multiple streams, each marked cached ([TB+]) / "Your media"
- **Latest Added 4k (paginated)** — a date-sorted "4k" catalog paged 20 items at a time via Stremio's infinite scroll, backed by Jackett offset pagination; grouping is applied before paging so a title appears once
- **Stremio search** — searching in Stremio runs a Jackett search (sorted by size then name); same-title results are grouped, and each source plays through TorBox with cached / "Your media" status
- Public / Private trackers
- TV packs priority
- Sorting
- Qualities filter
- Excludes keywords
- Good performances (caching of requests / search, prepare next episode ...)

## Automatic installation using cli script (recommended)

The cli script will install, configure, secure and update your addon. **Docker must be installed on your machine for the automatic installation.**

Three automatic installation options are available using cli script:

- 1) **Traefik** (recommended) - 
 You must have a domain configured for this machine, ports 80 and 443 must be opened.
 Your Addon will be available on the address: `https://your_domain`
 You can use [noip](https://www.noip.com) to create a free domain.

- 2) **Localtunnel** - 
 This installation use "[localtunnel](https://localtunnel.me/)" to expose the app on Internet.
 There's no need to configure a domain; you can run it directly on your local machine.
 However, you may encounter limitations imposed by LocalTunnel.
 All requests from the addons will go through LocalTunnel.
 Your Addon will be available on the address like `https://random-id.localtunnel.me`

- 3) **Local** - 
 Install locally without domain. Stremio App must run in same machine to work.
 Your Addon will be available on the address: `http://localhost`


```sh
# Create the directory where you want to store the installation configs
mkdir /home/jackettio && cd /home/jackettio

# Download the cli script
curl -fsSL https://raw.githubusercontent.com/arvida42/jackettio/master/cli.sh -o cli.sh

# Run the install
chmod +x ./cli.sh && ./cli.sh install
```


### cli scripts commands details
```sh
# Install all containers and configure them
./cli.sh install

# Update all containers to the last version
./cli.sh update

# Stop all containers
./cli.sh stop

# Start all containers
./cli.sh start

# Stop and remove all containers.
./cli.sh down

# Reset jackett dashboard password
.cli.sh jackett-password
```

## Manual installation

**You must have a Jackett instance installed for manual installation.**

```sh
# Clone the repo
git clone https://github.com/arvida42/jackettio.git

# Go inside the folder
cd jackettio

# Install dependencies
npm install

# Run
JACKETT_API_KEY=API_KEY JACKETT_URL=http://localhost:9117 npm start
```

## Manual installation with Docker image

```sh
# Create env file
touch .env

# Add settings to env file, change these settings with yours
# See configuration below
echo "JACKETT_URL=http://localhost:9117" >> .env
echo "JACKETT_API_KEY=key" >> .env

# Create data volume
docker volume create jackettio_data

# Run the container
docker run --env-file .env \
    -v jackettio_data:/data \
    -e DATA_FOLDER=/data \
    --name jackettio \
    -p 4000:4000 \
    -d arvida42/jackettio:latest
```

## Deploy to Vercel

The addon can run as a Vercel serverless function. A serverless entrypoint (`api/index.js`)
and `vercel.json` are included; when running on Vercel the app skips the long-running HTTP
server / background jobs and uses an in-memory cache instead of SQLite.

Steps:

1. Import this repository into a new Vercel project (Framework Preset: **Other**).
2. Add the required environment variables in **Project Settings → Environment Variables**:
   - `JACKETT_URL` — URL of your Jackett instance
   - `JACKETT_API_KEY` — your Jackett API key
   - (recommended) `REDIS_URL` — a Redis connection string for a persistent, shared cache (see below)
   - (optional) `OMDB_API_KEY` — show IMDb + Rotten Tomatoes ratings in stream titles (see below)
   - (optional) any `ADDON_*` / `DEFAULT_*` settings from [config.js](src/lib/config.js)
3. Deploy, then open `https://<your-project>.vercel.app/configure` to configure and install
   the addon in Stremio.

### Persistent cache (recommended on Vercel)

By default the cache is in-memory, which on Vercel lives only in a single warm serverless
instance — it's lost on cold starts, redeploys, and isn't shared between instances (so a stream
opened on a different instance than the catalog can come back empty). Point the addon at an
external Redis and the cache (resolved hashes, catalog stashes, posters) **persists across cold
starts & redeploys and is shared across all instances**.

The addon auto-detects, in priority order:

1. **Upstash / Vercel KV (REST)** — `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or
   Vercel KV's `KV_REST_API_URL` + `KV_REST_API_TOKEN`. These are injected automatically when you
   add the **Upstash** integration (Vercel → Storage / Integrations), so you just **redeploy** and
   it's used. This REST client is the recommended one for serverless (no TCP connection limits).
2. **TCP Redis** — `REDIS_URL` or `KV_URL` (e.g. a `rediss://…` string) via ioredis, for a
   self-hosted Redis or if you prefer the TCP endpoint.

Works on any host (Vercel, Docker, local). After adding the integration, **redeploy** and check
the deployment's Runtime Logs for `Cache store: upstash-rest` (or `redis`) to confirm it's active.

**Important caveats:**

- **Jackett cannot run on Vercel.** You must host Jackett elsewhere (self-host / VPS) and point
  `JACKETT_URL` at a publicly reachable instance.
- **Without Redis, the cache is in-memory and ephemeral on Vercel** — it resets on cold starts and
  isn't shared across instances (affects speed, and occasionally a freshly-opened item may need the
  catalog reopened). Set `REDIS_URL`/`KV_URL` to make it persistent. `CACHE_STORE=memory` forces
  the in-memory store outside Vercel.
- **Function time limit.** Vercel's Hobby plan caps serverless functions at 10s; heavy Jackett
  searches can exceed this and time out. Use Vercel Pro (higher limits) or the Docker deployment
  for reliable use with slow indexers.

### Ratings in stream titles (optional)

Stream titles can show a rating line on top, e.g. `⭐ 7.6  🍅 85%  Ⓜ️ 67`
(IMDb / Rotten Tomatoes / Metacritic):

- **Without any key** — the free Cinemeta feed provides the **movie / show-level IMDb rating**
  (the same value shows for every episode of a series; no Rotten Tomatoes or Metacritic).
- **With `OMDB_API_KEY`** — [OMDb](https://www.omdbapi.com/apikey.aspx) (free tier, 1000
  requests/day) adds the **Rotten Tomatoes** (critics) and **Metacritic** scores plus
  **per-episode IMDb ratings** for series — all in one request. Rotten Tomatoes / Metacritic only
  rate movies and whole titles, so episode lines typically show the IMDb rating only.

Ratings appear across all flows: streams opened from any Stremio catalog (native), the **TorBox
Downloads** catalog (per-episode for series), and the **Jackett search** catalog (show-level).
They're cached for a day and, in the native flow, fetched in parallel with the torrent search, so
they add no latency. Works on any host (Vercel, Docker, local) — just set `OMDB_API_KEY`.

## Configuration

Jackettio is designed for selfhosted, whether for personal or public use. As a server owner, effortlessly configure many settings with environement variables.

- **Addon ID** `ADDON_ID` Change the `id` field in stremio manifest
- **Default user settings:** `DEFAULT_*` All default settings available for user configuration on the /configure page are fully customizable
- **Immulatable user settings:** `IMMULATABLE_USER_CONFIG_KEYS` List of user settings that will no longer be accessible for modification or viewing on the /configure page. Example: `maxTorrents,priotizePackTorrents`
- And mores ..., see all configurations in [config.js file](https://github.com/arvida42/jackettio/blob/master/src/lib/config.js).