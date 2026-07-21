import showdown from 'showdown';
import compression from 'compression';
import express from 'express';
import localtunnel from 'localtunnel';
import { rateLimit } from 'express-rate-limit';
import {readFileSync} from "fs";
import config from './lib/config.js';
import cache, {vacuum as vacuumCache, clean as cleanCache} from './lib/cache.js';
import path from 'path';
import * as meta from './lib/meta.js';
import * as rating from './lib/rating.js';
import * as omdb from './lib/omdb.js';
import * as icon from './lib/icon.js';
import * as debrid from './lib/debrid.js';
import {getIndexers, searchTorrents} from './lib/jackett.js';
import * as jackettio from "./lib/jackettio.js";
import {cleanTorrentFolder, createTorrentFolder, get as getTorrentInfos, getTorrentFile} from './lib/torrentInfos.js';
import {bytesToSize, numberPad, promiseTimeout, wait} from './lib/util.js';
import {generatePoster, generatePosterSvg} from './lib/poster.js';
import pLimit from 'p-limit';

const converter = new showdown.Converter();
const welcomeMessageHtml = config.welcomeMessage ? `${converter.makeHtml(config.welcomeMessage)}<div class="my-4 border-top border-secondary-subtle"></div>` : '';
const addon = JSON.parse(readFileSync(path.join(import.meta.dirname, '../package.json')));
const app = express();

const respond = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Content-Type', 'application/json')
  res.send(data)
};

const getBaseUrl = (req) => `${req.hostname == 'localhost' ? 'http' : 'https'}://${req.hostname}`;

// Prevent Stremio (and any CDN) from caching a response — used for the TorBox catalog/meta so
// deletes and new downloads show up immediately instead of a stale cached list.
const noCache = (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};

// Extract a lowercased btih infohash from a Jackett result (attr or magnet), or '' if absent.
const itemInfoHash = (item) => {
  if(item.infoHash)return `${item.infoHash}`.toLowerCase();
  const match = `${item.magneturl || ''}`.match(/btih:([a-z0-9]+)/i);
  return match ? match[1].toLowerCase() : '';
};

// Heuristic: does a torrent/download name look like a TV series (season/episode markers)?
const isSeriesName = (name) => /\b(s\d{1,2}e\d{1,3}|s\d{1,2}|\d{1,2}x\d{2}|season\s*\d+|complete\s+series)\b/i.test(`${name}`);

// Is a TorBox download a series? Its name may lack season/episode markers (e.g. "House of the
// Dragon 2160p"), so also treat it as a series when it contains 2+ episode-looking video files
// (a season pack). Keeps series out of the movie catalog and into the series one.
const isSeriesDownload = (item) => isSeriesName(item.name) || (item.episodeCount || 0) >= 2;

// Stremio won't show streams for a `series` meta until it has a videos[] entry to click. Our
// grouped Jackett items are flat (one set of source torrents, like a movie), so we expose a single
// placeholder episode whose id routes back to the same stream handler (the `:1:1` suffix is
// tolerated by the id parsing in the stream/meta routes).
const seriesVideos = (id, name) => [{
  id: `${id}:1:1`,
  title: name,
  season: 1,
  episode: 1,
  released: new Date().toISOString()
}];

// Best-effort season/episode from a file/torrent name (SxxExx or NxNN), or null.
const parseEpisode = (name) => {
  const m = `${name}`.match(/s(\d{1,2})[ ._-]*e(\d{1,3})/i) || `${name}`.match(/\b(\d{1,2})x(\d{1,2})\b/);
  return m ? {season: parseInt(m[1]), episode: parseInt(m[2])} : null;
};

// A TorBox download's video files as a Stremio series videos[]: one clickable episode per file, so
// opening a series download lists every episode (not a single placeholder). Each video id carries
// the file id (torbox:<torrentId>:<fileId>) so the stream route can resolve just that file.
const torboxSeriesVideos = (torrentId, files) => files
  .map((file, i) => {
    const se = parseEpisode(file.name);
    const fileId = `${file.id}`.split(':')[1];
    return {
      id: `torbox:${torrentId}:${fileId}`,
      title: file.name,
      season: se ? se.season : 1,
      episode: se ? se.episode : i + 1,
      released: new Date().toISOString()
    };
  })
  .sort((a, b) => a.season - b.season || a.episode - b.episode);

// URL of a generated fallback poster (cleaned title + year) for an item without real artwork.
const generatedPosterUrl = (req, name) => {
  const {title, year} = meta.parseTitleFromName(name);
  const query = new URLSearchParams({title: title || name});
  if(year)query.set('tag', `${year}`);
  return `${getBaseUrl(req)}/poster.png?${query.toString()}`;
};

// Artwork fields for a media title: a poster (real or generated) and the imdb_id (tt) when the
// title resolves to a real IMDb entry. Spread into a meta/metaPreview object.
async function artworkFor(req, name, hintType){
  const info = await meta.searchInfo(name, hintType).catch(() => ({poster: null, imdbId: null}));
  return {
    poster: info.poster || generatedPosterUrl(req, name),
    ...(info.imdbId ? {imdb_id: info.imdbId} : {})
  };
}

// Fallback when a group stash has expired but the individual torrent is still cached.
async function singleAsGroup(id){
  const info = await cache.get(`jackettio:torrent:${id}`);
  return info ? {name: info.name, imdbId: null, poster: null, ids: [id]} : null;
}

// Time budget for the whole /stream request. Vercel Hobby kills the function at 10s, so we aim to
// finish well under that: resolve private-source hashes sequentially (with a cooldown between
// tracker downloads) only while budget remains, reserving time for the cache check + response.
const STREAM_BUDGET_MS = 9000;      // target ceiling for the whole request
const STREAM_STATUS_RESERVE_MS = 2000; // reserve for getHashesStatus + sending the response
const HASH_RESOLVE_GAP_MS = 600;    // cooldown between .torrent downloads (tracker politeness)
const HASH_RESOLVE_OP_MS = 4000;    // per-download cap

// Resolve one private source's infohash from its .torrent link. '' on failure/timeout.
async function resolveInfoHash(info, timeoutMs){
  try {
    const parsed = await promiseTimeout(getTorrentInfos({link: info.link, id: info.id, name: info.name, size: info.size, infoHash: info.infoHash, type: info.type}), timeoutMs);
    return (parsed && parsed.infoHash) || '';
  }catch(err){
    return '';
  }
}

const limiter = rateLimit({
  windowMs: config.rateLimitWindow * 1000,
  max: config.rateLimitRequest,
  legacyHeaders: false,
  standardHeaders: 'draft-7',
  keyGenerator: (req) => req.clientIp || req.ip,
  handler: (req, res, next, options) => {
    if(req.route.path == '/:userConfig/stream/:type/:id.json'){
      const resetInMs = new Date(req.rateLimit.resetTime) - new Date();
      return res.json({streams: [{
        name: `${config.addonName}`,
        title: `🛑 Too many requests, please try in ${Math.ceil(resetInMs / 1000 / 60)} minute(s).`,
        url: '#'
      }]})
    }else{
      return res.status(options.statusCode).send(options.message);
    }
  }
});

app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  req.clientIp = req.ip;
  if(req.get('CF-Connecting-IP')){
    req.clientIp = req.get('CF-Connecting-IP');
  }
  next();
});

app.use(compression());
app.use(express.static(path.join(import.meta.dirname, 'static'), {maxAge: 86400e3}));

app.get('/', (req, res) => {
  res.redirect('/configure')
  res.end();
});

app.get('/icon', async (req, res) => {
  const filePath = await icon.getLocation();
  res.contentType(path.basename(filePath));
  res.setHeader('Cache-Control', `public, max-age=${3600}`);
  return res.sendFile(filePath);
});

// Generated fallback poster: a title-on-color image for catalog items without real artwork.
// Prefers a PNG (native canvas, best client compatibility); if canvas is unavailable on the
// host it serves a dependency-free SVG instead, so a generated poster always renders.
app.get('/poster.png', async (req, res) => {
  const title = `${req.query.title || 'Unknown'}`.slice(0, 120);
  const subtitle = req.query.tag ? `${req.query.tag}`.slice(0, 40) : '';
  try {
    const buffer = await generatePoster(title, subtitle);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(buffer);
  }catch(err){
    console.log('poster (png unavailable, serving svg)', err.message || err);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(generatePosterSvg(title, subtitle));
  }
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path.replace(/\/eyJ[\w\=]+/g, '/*******************')}`);
  next();
});

app.get('/:userConfig?/configure', async(req, res) => {
  let indexers = (await getIndexers().catch(() => []))
    .map(indexer => ({
      value: indexer.id, 
      label: indexer.title, 
      types: ['movie', 'series'].filter(type => indexer.searching[type].available)
    }));
  const templateConfig = {
    debrids: await debrid.list(),
    addon: {
      version: addon.version,
      name: config.addonName
    },
    userConfig: req.params.userConfig || '',
    defaultUserConfig: config.defaultUserConfig,
    qualities: config.qualities,
    languages: config.languages.map(l => ({value: l.value, label: l.label})).filter(v => v.value != 'multi'),
    metaLanguages: await meta.getLanguages(),
    sorts: config.sorts,
    indexers,
    passkey: {enabled: false},
    immulatableUserConfigKeys: config.immulatableUserConfigKeys
  };
  if(config.replacePasskey){
    templateConfig.passkey = {
      enabled: true,
      infoUrl: config.replacePasskeyInfoUrl,
      pattern: config.replacePasskeyPattern
    }
  }
  let template = readFileSync(path.join(import.meta.dirname, 'template/configure.html')).toString()
    .replace('/** import-config */', `const config = ${JSON.stringify(templateConfig, null, 2)}`)
    .replace('<!-- welcome-message -->', welcomeMessageHtml);
  return res.send(template);
});

// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md#using-user-data-in-addons
app.get("/:userConfig?/manifest.json", async(req, res) => {
  const manifest = {
    id: config.addonId,
    version: addon.version,
    name: config.addonName,
    description: config.addonDescription,
    icon: `${req.hostname == 'localhost' ? 'http' : 'https'}://${req.hostname}/icon`,
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {configurable: true}
  };
  if(req.params.userConfig){
    const userConfig = JSON.parse(atob(req.params.userConfig));
    const debridInstance = debrid.instance(userConfig);
    manifest.name += ` ${debridInstance.shortName}`;
    // TorBox exposes the user's completed downloads as a browsable catalog.
    if(userConfig.debridId === 'torbox'){
      manifest.resources = ["stream", "catalog", "meta"];
      manifest.idPrefixes = ["tt", "torbox:", "jackettio:"];
      manifest.catalogs = [
        {type: "movie", id: "torbox-downloads", name: "TorBox Downloads"},
        // Series counterpart of the TorBox downloads catalog (season/episode downloads).
        {type: "series", id: "torbox-downloads-series", name: "TorBox Downloads"},
        {type: "movie", id: "latest-4k", name: "Latest added 4k (3d)"},
        {type: "movie", id: "latest-4k-1w", name: "Latest added 4k (1w)"},
        // Paginated (Stremio skip) date-sorted "latest 4k", 20 grouped items per page.
        {type: "movie", id: "latest-4k-paged", name: "Latest Added 4k", extra: [{name: "skip"}], extraSupported: ["skip"]},
        // Search-only catalog: appears when the user searches in Stremio, runs a Jackett search.
        {
          type: "movie",
          id: "jackettio-search",
          name: "Jackett",
          extra: [{name: "search", isRequired: true}],
          extraSupported: ["search"],
          extraRequired: ["search"]
        },
        // Series counterpart of the search catalog, so a Stremio search also surfaces series.
        {
          type: "series",
          id: "jackettio-search-series",
          name: "Jackett",
          extra: [{name: "search", isRequired: true}],
          extraSupported: ["search"],
          extraRequired: ["search"]
        }
      ];
    }
  }
  respond(res, manifest);
});

// Run a Jackett search and turn the results into GROUPED Stremio metas: torrents for the same
// title/movie are merged into one item (id: jackettio:<groupId>) whose streams are the individual
// sources. recentDays > 0 keeps only items published in that window; sortKey orders results.
async function buildJackettMetas(req, {query, recentDays, sortKey, type = 'movie'}){
  const cutoff = Date.now() - (recentDays || 0) * 24 * 3600 * 1000;
  const raw = await searchTorrents({query});
  let resolvable = raw.filter(item => item.link || item.magneturl || item.infoHash);
  // Series catalogs keep only season/episode-looking results; movie catalogs stay unfiltered.
  if(type === 'series')resolvable = resolvable.filter(item => isSeriesName(item.name));
  const sorted = (recentDays ? resolvable.filter(item => item.pubDate >= cutoff) : resolvable)
    .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0) || `${a.name}`.localeCompare(`${b.name}`));
  console.log(`jackett "${query}" (${type}): ${raw.length} results, ${resolvable.length} resolvable${recentDays ? `, ${sorted.length} within last ${recentDays}d` : ''}`);

  // Dedupe identical torrents, then group locally by parsed title+year (no network).
  const seen = new Set();
  const prelim = new Map();
  for(const item of sorted){
    const dedupeKey = itemInfoHash(item) || item.id;
    if(seen.has(dedupeKey))continue;
    seen.add(dedupeKey);
    const {title, year} = meta.parseTitleFromName(item.name);
    const key = `${title.toLowerCase()}|${year || ''}`;
    if(!prelim.has(key)){
      if(prelim.size >= 60)continue; // cap distinct groups to bound metadata lookups
      prelim.set(key, {title, year, sample: item.name, items: []});
    }
    prelim.get(key).items.push(item);
  }

  // One metadata lookup per preliminary group (cached), then merge groups sharing an imdb id.
  const limit = pLimit(5);
  const resolved = await Promise.all([...prelim.values()].map(g => limit(async () => {
    const info = await meta.searchInfo(g.sample, type).catch(() => ({poster: null, imdbId: null, name: null}));
    return {...g, info};
  })));

  const merged = new Map();
  for(const g of resolved){
    const key = g.info.imdbId || `local:${g.title.toLowerCase()}|${g.year || ''}`;
    if(!merged.has(key)){
      merged.set(key, {imdbId: g.info.imdbId || null, name: g.info.name || g.title || g.sample, poster: g.info.poster || null, items: []});
    }
    const m = merged.get(key);
    m.items.push(...g.items);
    if(!m.poster && g.info.poster)m.poster = g.info.poster;
  }

  const groups = [...merged.values()]
    .sort((a, b) => Math.max(...b.items.map(i => i.size)) - Math.max(...a.items.map(i => i.size)))
    .slice(0, 50);

  const metas = [];
  for(const g of groups){
    g.items.sort((a, b) => b.size - a.size);
    for(const item of g.items){
      await cache.set(`jackettio:torrent:${item.id}`, {
        id: item.id, link: item.link, magneturl: item.magneturl || '', infoHash: itemInfoHash(item),
        name: item.name, size: item.size, type: item.type
      }, {ttl: 3 * 24 * 3600});
    }
    const groupId = g.imdbId || g.items[0].id;
    await cache.set(`jackettio:group:${groupId}`, {
      name: g.name, imdbId: g.imdbId, poster: g.poster, ids: g.items.map(i => i.id)
    }, {ttl: 3 * 24 * 3600});
    metas.push({
      id: `jackettio:${groupId}`,
      type,
      name: g.name,
      poster: g.poster || generatedPosterUrl(req, g.name),
      posterShape: 'poster',
      // Series metas are kept id-routed (no imdb_id) so Stremio opens OUR meta, not Cinemeta's.
      ...(type !== 'series' && g.imdbId ? {imdb_id: g.imdbId} : {}),
      description: `${g.items.length} source${g.items.length > 1 ? 's' : ''}`
    });
  }
  return metas;
}

const PAGE_SIZE = 20;
const POOL_MAX = 300; // Jackett items to pull (paginated) before grouping

// Fetch up to maxItems from Jackett using its offset pagination.
async function fetchJackettPool(query, maxItems){
  const pageSize = 100;
  const all = [];
  for(let offset = 0; offset < maxItems; offset += pageSize){
    const page = await searchTorrents({query, limit: pageSize, offset});
    if(!page.length)break;
    all.push(...page);
    if(page.length < pageSize)break; // last page
  }
  return all;
}

// Build the grouped, newest-first list for the paginated catalog ONCE (grouping happens before
// paging, so a title never splits across pages), then cache the ordered list of light groups.
async function getPagedGroupList(query){
  const cacheKey = `jackettio:pagedgroups:${query}`;
  let list = await cache.get(cacheKey);
  if(list)return list;

  const pool = await fetchJackettPool(query, POOL_MAX);
  const resolvable = pool.filter(item => item.link || item.magneturl || item.infoHash);
  const seen = new Set();
  const groups = new Map();
  for(const item of resolvable){
    const dedupeKey = itemInfoHash(item) || item.id;
    if(seen.has(dedupeKey))continue;
    seen.add(dedupeKey);
    const {title, year} = meta.parseTitleFromName(item.name);
    const key = `${title.toLowerCase()}|${year || ''}`;
    if(!groups.has(key))groups.set(key, {title: title || item.name, sample: item.name, newest: 0, items: []});
    const g = groups.get(key);
    g.items.push({id: item.id, link: item.link, magneturl: item.magneturl || '', infoHash: itemInfoHash(item), name: item.name, size: item.size, type: item.type});
    g.newest = Math.max(g.newest, item.pubDate || 0);
  }

  list = [...groups.values()];
  for(const g of list)g.items.sort((a, b) => b.size - a.size);
  list.sort((a, b) => b.newest - a.newest); // newest first
  console.log(`latest-4k-paged: ${pool.length} pool items -> ${list.length} groups`);

  await cache.set(cacheKey, list, {ttl: 3600});
  return list;
}

// One page (20 grouped items) of the paginated catalog. Artwork/imdb is resolved per page only.
async function buildLatestPage(req, query, skip){
  const list = await getPagedGroupList(query);
  const pageGroups = list.slice(skip, skip + PAGE_SIZE);
  const limit = pLimit(5);
  return Promise.all(pageGroups.map(g => limit(async () => {
    const info = await meta.searchInfo(g.sample).catch(() => ({poster: null, imdbId: null, name: null}));
    for(const item of g.items){
      await cache.set(`jackettio:torrent:${item.id}`, item, {ttl: 3 * 24 * 3600});
    }
    const groupId = info.imdbId || g.items[0].id;
    const name = info.name || g.title;
    await cache.set(`jackettio:group:${groupId}`, {name, imdbId: info.imdbId, poster: info.poster, ids: g.items.map(i => i.id)}, {ttl: 3 * 24 * 3600});
    return {
      id: `jackettio:${groupId}`,
      type: 'movie',
      name,
      poster: info.poster || generatedPosterUrl(req, name),
      posterShape: 'poster',
      ...(info.imdbId ? {imdb_id: info.imdbId} : {}),
      description: `${g.items.length} source${g.items.length > 1 ? 's' : ''}`
    };
  })));
}

// Catalog: TorBox downloads, and a Jackett "latest 4k" search. Metas get a best-effort poster
// lookup (cached) with bounded concurrency to stay responsive.
app.get("/:userConfig/catalog/:type/:id.json", async(req, res) => {
  noCache(res);
  try {
    const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
    if(userConfig.debridId !== 'torbox'){
      return respond(res, {metas: []});
    }
    const limit = pLimit(5);

    if(req.params.id === 'torbox-downloads'){
      // Movie catalog: TorBox downloads that are NOT series, so a season pack (House of the Dragon,
      // etc.) doesn't show here as a movie with a wrong, movie-matched poster.
      const items = (await debrid.instance(userConfig).getCatalogItems()).filter(item => !isSeriesDownload(item));
      const metas = await Promise.all(items.map(item => limit(async () => ({
        id: `torbox:${item.id}`,
        type: 'movie',
        name: item.name,
        ...(await artworkFor(req, item.name)),
        posterShape: 'poster',
        description: `TorBox download — ${bytesToSize(item.size)}`
      }))));
      return respond(res, {metas});
    }

    if(req.params.id === 'torbox-downloads-series'){
      // Same TorBox downloads, filtered to series (by name or by episode-looking files), typed as series.
      const items = (await debrid.instance(userConfig).getCatalogItems()).filter(isSeriesDownload);
      const metas = await Promise.all(items.map(item => limit(async () => {
        const art = await artworkFor(req, item.name, 'series');
        return {
          id: `torbox:${item.id}`,
          type: 'series',
          name: item.name,
          poster: art.poster,
          posterShape: 'poster',
          description: `TorBox download — ${bytesToSize(item.size)}`
        };
      })));
      return respond(res, {metas});
    }

    if(req.params.id === 'latest-4k'){
      // Jackett search "4k", keep items published in the last 3 days, sort by size desc.
      const metas = await buildJackettMetas(req, {query: '4k', recentDays: 3, sortKey: 'size'});
      return respond(res, {metas});
    }

    if(req.params.id === 'latest-4k-1w'){
      // Same as latest-4k but a 7-day window.
      const metas = await buildJackettMetas(req, {query: '4k', recentDays: 7, sortKey: 'size'});
      return respond(res, {metas});
    }

    if(req.params.id === 'latest-4k-paged'){
      // First page of the paginated, grouped, date-sorted "4k" catalog.
      const metas = await buildLatestPage(req, '4k', 0);
      return respond(res, {metas});
    }

    return respond(res, {metas: []});
  }catch(err){
    console.log('catalog', err);
    return respond(res, {metas: []});
  }
});

// Catalog extra segment: search (".../:id/search=<query>.json") and pagination
// (".../:id/skip=<n>.json") both arrive here.
app.get("/:userConfig/catalog/:type/:id/:extra.json", async(req, res) => {
  noCache(res);
  try {
    const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
    if(userConfig.debridId !== 'torbox'){
      return respond(res, {metas: []});
    }
    const params = new URLSearchParams(req.params.extra);

    if(req.params.id === 'jackettio-search'){
      const query = (params.get('search') || '').trim();
      if(!query)return respond(res, {metas: []});
      return respond(res, {metas: await buildJackettMetas(req, {query, recentDays: 0, sortKey: 'size'})});
    }

    if(req.params.id === 'jackettio-search-series'){
      const query = (params.get('search') || '').trim();
      if(!query)return respond(res, {metas: []});
      return respond(res, {metas: await buildJackettMetas(req, {query, recentDays: 0, sortKey: 'size', type: 'series'})});
    }

    if(req.params.id === 'latest-4k-paged'){
      const skip = Math.max(0, parseInt(params.get('skip') || '0') || 0);
      return respond(res, {metas: await buildLatestPage(req, '4k', skip)});
    }

    return respond(res, {metas: []});
  }catch(err){
    console.log('catalog extra', err);
    return respond(res, {metas: []});
  }
});

// Meta: detail page for a TorBox download (torbox:<torrentId>) or a Jackett item (jackettio:<hash>).
app.get("/:userConfig/meta/:type/:id.json", async(req, res) => {
  noCache(res);
  try {
    const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
    if(userConfig.debridId !== 'torbox'){
      return respond(res, {meta: {}});
    }

    if(req.params.id.startsWith('torbox:')){
      const torrentId = req.params.id.split(':')[1];
      const details = await debrid.instance(userConfig).getTorrentDetails(torrentId);
      if(!details){
        return respond(res, {meta: {}});
      }
      // Resolve the poster with the right type hint so a series doesn't match a same-named movie.
      const art = await artworkFor(req, details.name, req.params.type === 'series' ? 'series' : undefined);
      const description = details.files.map(file => `${file.name} — ${bytesToSize(file.size)}`).join('\n');
      if(req.params.type === 'series'){
        // One clickable episode per video file in the download, so every episode shows.
        return respond(res, {meta: {
          id: req.params.id,
          type: 'series',
          name: details.name,
          poster: art.poster,
          posterShape: 'poster',
          background: art.poster,
          description,
          videos: torboxSeriesVideos(torrentId, details.files)
        }});
      }
      return respond(res, {meta: {
        id: req.params.id,
        type: 'movie',
        name: details.name,
        ...art,
        posterShape: 'poster',
        background: art.poster,
        description
      }});
    }

    if(req.params.id.startsWith('jackettio:')){
      const groupId = req.params.id.split(':')[1];
      const group = await cache.get(`jackettio:group:${groupId}`) || await singleAsGroup(groupId);
      if(!group){
        return respond(res, {meta: {}});
      }
      // Enrich the detail page with OMDb data (plot, cast/director/writer/genres via links,
      // released, runtime, awards, imdbRating) when we have an IMDb id and OMDb is configured.
      // Best-effort; both lookups share the same cached OMDb record, so it's one request.
      const record = group.imdbId ? await omdb.getById(group.imdbId).catch(() => null) : null;
      const enrich = omdb.stremioMetaFields(record);
      const ratingLine = group.imdbId ? await rating.getRatingLine({imdbId: group.imdbId, type: req.params.type}).catch(() => '') : '';
      console.log(`meta ${req.params.id}: imdbId=${group.imdbId || '-'} omdb=${record ? 'hit' : 'miss'} links=${(enrich.links || []).length}`);
      const poster = group.poster || (record && record.poster) || generatedPosterUrl(req, group.name);
      // Description: "N sources via TorBox, <ratings>," then the plot beneath.
      const sourceLine = `${group.ids.length} source${group.ids.length > 1 ? 's' : ''} via TorBox`;
      const header = ratingLine ? `${sourceLine}, ${ratingLine}` : sourceLine;
      const description = record && record.plot ? `${header},\n${record.plot}` : header;
      if(req.params.type === 'series'){
        return respond(res, {meta: {
          id: req.params.id,
          type: 'series',
          name: group.name,
          poster,
          posterShape: 'poster',
          background: poster,
          ...enrich,
          description,
          videos: seriesVideos(req.params.id, group.name)
        }});
      }
      return respond(res, {meta: {
        id: req.params.id,
        type: 'movie',
        name: group.name,
        poster,
        posterShape: 'poster',
        background: poster,
        ...(group.imdbId ? {imdb_id: group.imdbId} : {}),
        ...enrich,
        description
      }});
    }

    return respond(res, {meta: {}});
  }catch(err){
    console.log('meta', err);
    return respond(res, {meta: {}});
  }
});

app.get("/:userConfig/stream/:type/:id.json", limiter, async(req, res) => {

  const reqStart = Date.now();

  try {

    // TorBox catalog items resolve to the download's video files instead of a Jackett search.
    if(req.params.id.startsWith('torbox:')){
      const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
      const segs = req.params.id.slice('torbox:'.length).split(':');
      const torrentId = segs[0];
      // A series episode targets a specific file (torbox:<tid>:<fileId>); the movie / whole-download
      // form (torbox:<tid>) lists every file. The legacy placeholder (torbox:<tid>:1:1) also lists all.
      const fileId = segs.length === 2 ? segs[1] : null;
      const debridInstance = debrid.instance(userConfig);
      const details = await debridInstance.getTorrentDetails(torrentId);
      let files = details ? details.files : [];
      const totalSize = details ? details.size : 0;
      const isPack = files.length > 1;
      if(fileId !== null)files = files.filter(file => `${file.id}` === `${torrentId}:${fileId}`);
      // Resolve the download's IMDb id (from its name) once so streams can show ⭐/🍅/Ⓜ️ ratings.
      // The whole-download / movie view reuses one show-level rating; a single-episode view gets a
      // per-episode rating below.
      const info = details ? await meta.searchInfo(details.name, req.params.type).catch(() => ({imdbId: null})) : {imdbId: null};
      const showImdb = info.imdbId;
      const sharedRating = showImdb && fileId === null
        ? await rating.getRatingLine({imdbId: showImdb, type: req.params.type}).catch(() => '')
        : '';
      const streams = await Promise.all(files.map(async file => {
        const [tId, fId] = file.id.split(':');
        // Single-episode view (series): status line on top — S01E01 · episode size / whole-download
        // size — so it matches the native series streams and shows both sizes.
        const rows = [];
        let ratingLine = sharedRating;
        if(fileId !== null){
          const se = parseEpisode(file.name);
          if(showImdb)ratingLine = await rating.getRatingLine({imdbId: showImdb, type: 'series', season: se ? se.season : null, episode: se ? se.episode : null}).catch(() => '');
          const label = se ? `🎬 S${numberPad(se.season)}E${numberPad(se.episode)} · ` : '🎬 ';
          const sizeStr = isPack && file.size < totalSize ? `${bytesToSize(file.size)} / ${bytesToSize(totalSize)}` : bytesToSize(file.size);
          if(ratingLine)rows.push(ratingLine);
          rows.push(`${label}${sizeStr}`, file.name);
        }else{
          if(ratingLine)rows.push(ratingLine);
          rows.push(file.name, bytesToSize(file.size));
        }
        return {
          name: `[TB] ${config.addonName}`,
          title: rows.join('\n'),
          url: `${getBaseUrl(req)}/${req.params.userConfig}/torbox/play/${tId}/${fId}/${encodeURIComponent(file.name)}`,
          // Binge auto-play: every episode of this download shares a bingeGroup keyed on the
          // download id, so Stremio auto-continues to the next episode from the same download.
          behaviorHints: {bingeGroup: `${config.addonId}|torbox|${torrentId}`}
        };
      }));
      // Whole-download view only (not a single-episode view) gets the delete action. Playing it
      // permanently deletes this download from TorBox; Stremio fails to play the 204, which is fine.
      if(details && fileId === null){
        streams.push({
          name: `🗑️ ${config.addonName}`,
          title: `Delete this download from TorBox`,
          url: `${getBaseUrl(req)}/${req.params.userConfig}/torbox/delete/${torrentId}/${encodeURIComponent(details.name)}`
        });
      }
      return respond(res, {streams});
    }

    // Jackett group: one stream per source torrent, each marked cached (+) / "Your media".
    if(req.params.id.startsWith('jackettio:')){
      const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
      const groupId = req.params.id.split(':')[1];
      const group = await cache.get(`jackettio:group:${groupId}`) || await singleAsGroup(groupId);
      if(!group){
        return respond(res, {streams: []});
      }
      const debridInstance = debrid.instance(userConfig);
      const items = (await Promise.all(group.ids.map(async id => {
        const info = await cache.get(`jackettio:torrent:${id}`);
        return info ? {id, info} : null;
      }))).filter(Boolean);
      // Gently resolve real infohashes for private link-only sources so [TB+] can show on first
      // open — but sequentially, with a cooldown, and only while the request's time budget lasts,
      // so the whole response stays under Vercel's timeout. Resolved hashes are persisted (one-time).
      const deadline = reqStart + STREAM_BUDGET_MS - STREAM_STATUS_RESERVE_MS;
      const pending = items.filter(x => !x.info.infoHash && x.info.link);
      for(let i = 0; i < pending.length; i++){
        const remaining = deadline - Date.now();
        if(remaining < 700)break; // not enough time for another download; the rest fill in on play
        if(i > 0)await wait(HASH_RESOLVE_GAP_MS);
        const x = pending[i];
        const hash = await resolveInfoHash(x.info, Math.min(HASH_RESOLVE_OP_MS, Math.max(500, deadline - Date.now())));
        if(hash){
          x.info.infoHash = hash;
          await cache.set(`jackettio:torrent:${x.id}`, x.info, {ttl: 3 * 24 * 3600});
        }
      }
      // One batched cache/account check for all sources in the group.
      const statuses = await debridInstance.getHashesStatus(items.map(x => ({infoHash: x.info.infoHash, name: x.info.name}))).catch(() => items.map(() => ({cached: false, inAccount: false})));
      const sources = items.map((x, i) => ({...x, status: statuses[i] || {cached: false, inAccount: false}}));
      // Cached first, then largest.
      sources.sort((a, b) => (b.status.cached ? 1 : 0) - (a.status.cached ? 1 : 0) || (b.info.size - a.info.size));
      // Show-level rating for the whole group (browse groups have no per-episode context).
      const ratingLine = group.imdbId ? await rating.getRatingLine({imdbId: group.imdbId, type: req.params.type}).catch(() => '') : '';
      const streams = sources.map(({id, info, status}) => {
        const rows = [];
        if(ratingLine)rows.push(ratingLine);
        rows.push(info.name);
        if(status.inAccount)rows.push('📁 Your media');
        rows.push(bytesToSize(info.size));
        return {
          name: `[TB${status.cached ? '+' : ''}${status.inAccount ? '📁' : ''}] ${config.addonName}`,
          title: rows.join('\n'),
          url: `${getBaseUrl(req)}/${req.params.userConfig}/torbox/resolve/${id}/${encodeURIComponent(info.name)}`
        };
      });
      return respond(res, {streams});
    }

    const streams = await jackettio.getStreams(
      Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp}),
      req.params.type,
      req.params.id,
      `${req.hostname == 'localhost' ? 'http' : 'https'}://${req.hostname}`
    );

    return respond(res, {streams});

  }catch(err){

    console.log(req.params.id, err);
    return respond(res, {streams: []});

  }

});

app.get("/stream/:type/:id.json", async(req, res) => {

  return respond(res, {streams: [{
    name: config.addonName,
    title: `ℹ Kindly configure this addon to access streams.`,
    url: '#'
  }]});

});

// Resolve a Jackett search-catalog item: add it to TorBox (magnet, or a .torrent downloaded from
// the indexer link for private trackers) and play the largest video file. Uncached torrents
// surface as NOT_READY (TorBox starts fetching) until ready, like /download.
app.use('/:userConfig/torbox/resolve/:id/:name?', async(req, res, next) => {

  if (req.method !== 'GET' && req.method !== 'HEAD'){
    return next();
  }

  try {

    const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
    const debridInstance = debrid.instance(userConfig);
    // The video player re-hits this redirect frequently; resolving adds the torrent to TorBox and
    // requests a link each time. Cache the resolved URL per user+source so repeats are free (and
    // don't spam TorBox / the tracker).
    const urlCacheKey = `torbox:resolveurl:${await debridInstance.getUserHash()}:${req.params.id}`;
    let url = await cache.get(urlCacheKey);
    if(!url){
      const raw = await cache.get(`jackettio:torrent:${req.params.id}`);
      if(!raw){
        throw new Error('Torrent info expired — reopen the catalog');
      }
      if(raw.magneturl){
        // Public indexer: resolve straight from the magnet.
        url = await debridInstance.getMagnetDownload(raw.magneturl, raw.infoHash);
      }else{
        // Private indexer (no magnet): download + parse the .torrent from the indexer link,
        // then upload it to TorBox (or use the magnet if parsing yields a public one).
        const infos = await getTorrentInfos({link: raw.link, id: raw.id, name: raw.name, size: raw.size, infoHash: raw.infoHash, type: raw.type});
        // Persist the resolved hash so the cached badge can show next time — no extra download.
        if(infos.infoHash && !raw.infoHash){
          raw.infoHash = infos.infoHash;
          await cache.set(`jackettio:torrent:${req.params.id}`, raw, {ttl: 3 * 24 * 3600});
        }
        if(infos.magnetUrl){
          url = await debridInstance.getMagnetDownload(infos.magnetUrl, infos.infoHash);
        }else{
          const buffer = await getTorrentFile(infos);
          url = await debridInstance.getBufferDownload(buffer, infos.infoHash);
        }
      }
      if(url)await cache.set(urlCacheKey, url, {ttl: 3600});
    }

    res.status(302);
    res.set('location', url);
    res.send('');

  }catch(err){

    console.log('torbox resolve', req.params.id, err.message || err);

    switch(err.message){
      case debrid.ERROR.NOT_READY:
        res.status(302);
        res.set('location', `/videos/not_ready.mp4`);
        res.send('');
        break;
      case debrid.ERROR.EXPIRED_API_KEY:
        res.status(302);
        res.set('location', `/videos/expired_api_key.mp4`);
        res.send('');
        break;
      case debrid.ERROR.NOT_PREMIUM:
        res.status(302);
        res.set('location', `/videos/not_premium.mp4`);
        res.send('');
        break;
      default:
        res.status(302);
        res.set('location', `/videos/error.mp4`);
        res.send('');
    }

  }

});

// Resolve a TorBox catalog stream to a playable link at play time (lazy, like /download).
app.use('/:userConfig/torbox/play/:torrentId/:fileId/:name?', async(req, res, next) => {

  if (req.method !== 'GET' && req.method !== 'HEAD'){
    return next();
  }

  try {

    const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
    const debridInstance = debrid.instance(userConfig);
    // Cache the resolved link per user+file — the player re-hits this redirect often and each miss
    // is a TorBox requestdl call.
    const urlCacheKey = `torbox:playurl:${await debridInstance.getUserHash()}:${req.params.torrentId}:${req.params.fileId}`;
    let url = await cache.get(urlCacheKey);
    if(!url){
      url = await debridInstance.getDownload({id: `${req.params.torrentId}:${req.params.fileId}`});
      if(url)await cache.set(urlCacheKey, url, {ttl: 3600});
    }

    res.status(302);
    res.set('location', url);
    res.send('');

  }catch(err){

    console.log('torbox play', err);

    switch(err.message){
      case debrid.ERROR.NOT_READY:
        res.status(302);
        res.set('location', `/videos/not_ready.mp4`);
        res.send('');
        break;
      case debrid.ERROR.EXPIRED_API_KEY:
        res.status(302);
        res.set('location', `/videos/expired_api_key.mp4`);
        res.send('');
        break;
      case debrid.ERROR.NOT_PREMIUM:
        res.status(302);
        res.set('location', `/videos/not_premium.mp4`);
        res.send('');
        break;
      default:
        res.status(302);
        res.set('location', `/videos/error.mp4`);
        res.send('');
    }

  }

});

// Delete a TorBox download. Wired as a catalog item's "Delete" stream: playing it removes the
// download. Only an actual GET (play) deletes — a HEAD probe is a no-op — and Stremio simply
// can't play the 204, which is fine.
app.get('/:userConfig/torbox/delete/:torrentId/:name?', async(req, res) => {
  if(req.method === 'HEAD'){
    return res.status(204).end();
  }
  try {
    const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
    if(userConfig.debridId !== 'torbox'){
      throw new Error('Not a TorBox configuration');
    }
    const debridInstance = debrid.instance(userConfig);
    await debridInstance.deleteTorrent(req.params.torrentId);
    return res.status(204).end();
  }catch(err){
    console.log('torbox delete', err);
    return res.status(500).end();
  }
});

app.use('/:userConfig/download/:type/:id/:torrentId/:name?', async(req, res, next) => {

  if (req.method !== 'GET' && req.method !== 'HEAD'){
    return next();
  }

  try {

    const url = await jackettio.getDownload(
      Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp}),
      req.params.type, 
      req.params.id, 
      req.params.torrentId
    );

    const parsed = new URL(url);
    const cut = (value) => value ?  `${value.substr(0, 5)}******${value.substr(-5)}` : '';
    console.log(`${req.params.id} : Redirect: ${parsed.protocol}//${parsed.host}${cut(parsed.pathname)}${cut(parsed.search)}`);
    
    res.status(302);
    res.set('location', url);
    res.send('');

  }catch(err){

    console.log(req.params.id, err);

    switch(err.message){
      case debrid.ERROR.NOT_READY:
        res.status(302);
        res.set('location', `/videos/not_ready.mp4`);
        res.send('');
        break;
      case debrid.ERROR.EXPIRED_API_KEY:
        res.status(302);
        res.set('location', `/videos/expired_api_key.mp4`);
        res.send('');
        break;
      case debrid.ERROR.NOT_PREMIUM:
        res.status(302);
        res.set('location', `/videos/not_premium.mp4`);
        res.send('');
        break;
      case debrid.ERROR.ACCESS_DENIED:
        res.status(302);
        res.set('location', `/videos/access_denied.mp4`);
        res.send('');
        break;
      case debrid.ERROR.TWO_FACTOR_AUTH:
        res.status(302);
        res.set('location', `/videos/two_factor_auth.mp4`);
        res.send('');
        break;
      default:
        res.status(302);
        res.set('location', `/videos/error.mp4`);
        res.send('');
    }

  }

});

app.use((req, res) => {
  if (req.xhr) {
    res.status(404).send({ error: 'Page not found!' })
  } else {
    res.status(404).send('Page not found!');
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack)
  if (req.xhr) {
    res.status(500).send({ error: 'Something broke!' })
  } else {
    res.status(500).send('Something broke!');
  }
})

// Ensure the torrent working folder exists in every runtime (including serverless).
createTorrentFolder();

// Start the long-running HTTP server with its background jobs. Skipped on serverless
// platforms (e.g. Vercel), where the app is exported and invoked per-request instead.
function startServer(){

  const server = app.listen(config.port, async () => {

    console.log('───────────────────────────────────────');
    console.log(`Started addon ${addon.name} v${addon.version}`);
    console.log(`Server listen at: http://localhost:${config.port}`);
    console.log('───────────────────────────────────────');

    let tunnel;
    if(config.localtunnel){
      let subdomain = await cache.get('localtunnel:subdomain');
      tunnel = await localtunnel({port: config.port, subdomain});
      await cache.set('localtunnel:subdomain', tunnel.clientId, {ttl: 86400*365});
      console.log(`Your addon is available on the following address: ${tunnel.url}/configure`);
      tunnel.on('close', () => console.log("tunnels are closed"));
    }

    icon.download().catch(err => console.log(`Failed to download icon: ${err}`));

    const intervals = [];
    intervals.push(setInterval(cleanTorrentFolder, 3600e3));

    vacuumCache().catch(err => console.log(`Failed to vacuum cache: ${err}`));
    intervals.push(setInterval(() => vacuumCache(), 86400e3*7));

    cleanCache().catch(err => console.log(`Failed to clean cache: ${err}`));
    intervals.push(setInterval(() => cleanCache(), 3600e3));

    function closeGracefully(signal) {
      console.log(`Received signal to terminate: ${signal}`);
      if(tunnel)tunnel.close();
      intervals.forEach(interval => clearInterval(interval));
      server.close(() => {
        console.log('Server closed');
        process.kill(process.pid, signal);
      });
    }
    process.once('SIGINT', closeGracefully);
    process.once('SIGTERM', closeGracefully);

  });

}

if(!process.env.VERCEL){
  startServer();
}

export default app;