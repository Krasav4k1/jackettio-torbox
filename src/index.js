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
import * as icon from './lib/icon.js';
import * as debrid from './lib/debrid.js';
import {getIndexers, searchTorrents} from './lib/jackett.js';
import * as jackettio from "./lib/jackettio.js";
import {cleanTorrentFolder, createTorrentFolder, get as getTorrentInfos, getTorrentFile} from './lib/torrentInfos.js';
import {bytesToSize} from './lib/util.js';
import {generatePoster} from './lib/poster.js';
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

// URL of a generated fallback poster (cleaned title + year) for an item without real artwork.
const generatedPosterUrl = (req, name) => {
  const {title, year} = meta.parseTitleFromName(name);
  const query = new URLSearchParams({title: title || name});
  if(year)query.set('tag', `${year}`);
  return `${getBaseUrl(req)}/poster.png?${query.toString()}`;
};

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
app.get('/poster.png', async (req, res) => {
  try {
    const title = `${req.query.title || 'Unknown'}`.slice(0, 120);
    const subtitle = req.query.tag ? `${req.query.tag}`.slice(0, 40) : '';
    const buffer = await generatePoster(title, subtitle);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(buffer);
  }catch(err){
    console.log('poster', err);
    res.status(302);
    res.set('location', '/icon');
    return res.send('');
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
        {type: "movie", id: "latest-4k", name: "Latest added 4k (3d)"},
        {type: "movie", id: "latest-4k-1w", name: "Latest added 4k (1w)"},
        // Search-only catalog: appears when the user searches in Stremio, runs a Jackett search.
        {
          type: "movie",
          id: "jackettio-search",
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

// Run a Jackett search and turn the results into Stremio metas (id: jackettio:<jackettId>).
// recentDays > 0 keeps only items published in that window; sortKey orders results (size or
// seeders). Each item's resolution data is stashed so meta/stream can play it without
// re-searching. Poster lookups (cached) run with bounded concurrency.
async function buildJackettMetas(req, {query, recentDays, sortKey}){
  const cutoff = Date.now() - (recentDays || 0) * 24 * 3600 * 1000;
  const raw = await searchTorrents({query});
  const resolvable = raw.filter(item => item.link || item.magneturl || item.infoHash);
  const sorted = (recentDays ? resolvable.filter(item => item.pubDate >= cutoff) : resolvable)
    .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  console.log(`jackett "${query}": ${raw.length} results, ${resolvable.length} resolvable${recentDays ? `, ${sorted.length} within last ${recentDays}d` : ''}`);

  const seen = new Set();
  const torrents = [];
  for(const item of sorted){
    const key = itemInfoHash(item) || item.id;
    if(seen.has(key))continue;
    seen.add(key);
    torrents.push(item);
    if(torrents.length >= 50)break;
  }

  const limit = pLimit(5);
  return Promise.all(torrents.map(item => limit(async () => {
    await cache.set(`jackettio:torrent:${item.id}`, {
      id: item.id,
      link: item.link,
      magneturl: item.magneturl || '',
      infoHash: item.infoHash || '',
      name: item.name,
      size: item.size,
      type: item.type
    }, {ttl: 3 * 24 * 3600});
    return {
      id: `jackettio:${item.id}`,
      type: 'movie',
      name: item.name,
      poster: (await meta.searchPoster(item.name).catch(() => null)) || generatedPosterUrl(req, item.name),
      posterShape: 'poster',
      description: `${bytesToSize(item.size)} • 👥${item.seeders} • ⚙️${item.indexerId}`
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
      const items = await debrid.instance(userConfig).getCatalogItems();
      const metas = await Promise.all(items.map(item => limit(async () => ({
        id: `torbox:${item.id}`,
        type: 'movie',
        name: item.name,
        poster: (await meta.searchPoster(item.name).catch(() => null)) || generatedPosterUrl(req, item.name),
        posterShape: 'poster',
        description: `TorBox download — ${bytesToSize(item.size)}`
      }))));
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

    return respond(res, {metas: []});
  }catch(err){
    console.log('catalog', err);
    return respond(res, {metas: []});
  }
});

// Search catalog: Stremio calls this with an ".../:id/search=<query>.json" extra segment.
app.get("/:userConfig/catalog/:type/:id/:extra.json", async(req, res) => {
  noCache(res);
  try {
    const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
    const query = (new URLSearchParams(req.params.extra).get('search') || '').trim();
    if(userConfig.debridId !== 'torbox' || req.params.id !== 'jackettio-search' || !query){
      return respond(res, {metas: []});
    }
    const metas = await buildJackettMetas(req, {query, recentDays: 0, sortKey: 'seeders'});
    return respond(res, {metas});
  }catch(err){
    console.log('search catalog', err);
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
      const posterUrl = (await meta.searchPoster(details.name).catch(() => null)) || generatedPosterUrl(req, details.name);
      return respond(res, {meta: {
        id: req.params.id,
        type: 'movie',
        name: details.name,
        poster: posterUrl,
        posterShape: 'poster',
        background: posterUrl,
        description: details.files.map(file => `${file.name} — ${bytesToSize(file.size)}`).join('\n')
      }});
    }

    if(req.params.id.startsWith('jackettio:')){
      const jackettId = req.params.id.split(':')[1];
      const info = await cache.get(`jackettio:torrent:${jackettId}`);
      if(!info){
        return respond(res, {meta: {}});
      }
      const posterUrl = (await meta.searchPoster(info.name).catch(() => null)) || generatedPosterUrl(req, info.name);
      return respond(res, {meta: {
        id: req.params.id,
        type: 'movie',
        name: info.name,
        poster: posterUrl,
        posterShape: 'poster',
        background: posterUrl,
        description: `${bytesToSize(info.size)}`
      }});
    }

    return respond(res, {meta: {}});
  }catch(err){
    console.log('meta', err);
    return respond(res, {meta: {}});
  }
});

app.get("/:userConfig/stream/:type/:id.json", limiter, async(req, res) => {

  try {

    // TorBox catalog items resolve to the download's video files instead of a Jackett search.
    if(req.params.id.startsWith('torbox:')){
      const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
      const torrentId = req.params.id.split(':')[1];
      const debridInstance = debrid.instance(userConfig);
      const details = await debridInstance.getTorrentDetails(torrentId);
      const streams = (details ? details.files : []).map(file => {
        const [tId, fId] = file.id.split(':');
        return {
          name: `[TB] ${config.addonName}`,
          title: `${file.name}\n${bytesToSize(file.size)}`,
          url: `${getBaseUrl(req)}/${req.params.userConfig}/torbox/play/${tId}/${fId}/${encodeURIComponent(file.name)}`
        };
      });
      if(details){
        // Action stream: playing it permanently deletes this download from TorBox. Stremio will
        // fail to play the 204 response — that's expected; the deletion is the point.
        streams.push({
          name: `🗑️ ${config.addonName}`,
          title: `Delete this download from TorBox`,
          url: `${getBaseUrl(req)}/${req.params.userConfig}/torbox/delete/${torrentId}/${encodeURIComponent(details.name)}`
        });
      }
      return respond(res, {streams});
    }

    // Jackett search-catalog item: resolve it through TorBox at play time.
    if(req.params.id.startsWith('jackettio:')){
      const userConfig = Object.assign(JSON.parse(atob(req.params.userConfig)), {ip: req.clientIp});
      const jackettId = req.params.id.split(':')[1];
      const info = await cache.get(`jackettio:torrent:${jackettId}`) || {name: jackettId, size: 0};
      // Mark whether the torrent is cached on TorBox (+) and whether it's already in the account.
      const status = info.infoHash
        ? await debrid.instance(userConfig).getHashStatus(info.infoHash).catch(() => ({cached: false, inAccount: false}))
        : {cached: false, inAccount: false};
      const rows = [info.name];
      if(status.inAccount)rows.push('📁 Your media');
      rows.push(bytesToSize(info.size));
      return respond(res, {streams: [{
        name: `[TB${status.cached ? '+' : ''}] ${config.addonName}`,
        title: rows.join('\n'),
        url: `${getBaseUrl(req)}/${req.params.userConfig}/torbox/resolve/${jackettId}/${encodeURIComponent(info.name)}`
      }]});
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
    const raw = await cache.get(`jackettio:torrent:${req.params.id}`);
    if(!raw){
      throw new Error('Torrent info expired — reopen the catalog');
    }
    let url;
    if(raw.magneturl){
      // Public indexer: resolve straight from the magnet.
      url = await debridInstance.getMagnetDownload(raw.magneturl, raw.infoHash);
    }else{
      // Private indexer (no magnet): download + parse the .torrent from the indexer link,
      // then upload it to TorBox (or use the magnet if parsing yields a public one).
      const infos = await getTorrentInfos({link: raw.link, id: raw.id, name: raw.name, size: raw.size, infoHash: raw.infoHash, type: raw.type});
      if(infos.magnetUrl){
        url = await debridInstance.getMagnetDownload(infos.magnetUrl, infos.infoHash);
      }else{
        const buffer = await getTorrentFile(infos);
        url = await debridInstance.getBufferDownload(buffer, infos.infoHash);
      }
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
    const url = await debridInstance.getDownload({id: `${req.params.torrentId}:${req.params.fileId}`});

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