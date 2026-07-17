import pLimit from 'p-limit';
import {parseWords, numberPad, sortBy, bytesToSize, wait, promiseTimeout} from './util.js';
import config from './config.js';
import cache from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import * as rating from './rating.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

const slowIndexers = {};

const actionInProgress = {
  getTorrents: {},
  getDownload: {}
};

function parseStremioId(stremioId){
  const [id, season, episode] = stremioId.split(':');
  return {id, season: parseInt(season || 0), episode: parseInt(episode || 0)};
}

async function getMetaInfos(type, stremioId, language){
  const {id, season, episode} = parseStremioId(stremioId);
  if(type == 'movie'){
    return meta.getMovieById(id, language);
  }else if(type == 'series'){
    return meta.getEpisodeById(id, season, episode, language);
  }else{
    throw new Error(`Unsuported type ${type}`);
  }
}

async function mergeDefaultUserConfig(userConfig){
  config.immulatableUserConfigKeys.forEach(key => delete userConfig[key]);
  userConfig = Object.assign({}, config.defaultUserConfig, userConfig);
  userConfig = await updateUserConfigWithMediaFlowIp(userConfig);
  return userConfig;
}

function priotizeItems(allItems, priotizeItems, max){
  max = max || 0;
  if(typeof(priotizeItems) == 'function'){
    priotizeItems = allItems.filter(priotizeItems);
    if(max > 0)priotizeItems.splice(max);
  }
  if(priotizeItems && priotizeItems.length){
    allItems = allItems.filter(item => !priotizeItems.find(i => i == item));
    allItems.unshift(...priotizeItems);
  }
  return allItems;
}

function searchEpisodeFile(files, season, episode){
  return files.find(file => file.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 3)}`))
    || files.find(file => file.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 2)}`))
    || files.find(file => file.name.includes(`${season}${numberPad(episode, 2)}`))
    || files.find(file => file.name.includes(`${numberPad(episode, 2)}`))
    || false;
}

// Does a torrent name mark the requested season? Tolerant of language and format: English
// "Season 1"/"S01"/"S01-S03" AND Cyrillic "Сезон 1"/"1 сезон" (used by trackers like Toloka).
// Operates on the raw name — parseWords() strips Cyrillic, so it can't be used here.
function nameMatchesSeason(name, season){
  const s = `${name}`.toLowerCase();
  if(new RegExp(`\\bs0*${season}(?:\\b|e)`, 'i').test(s))return true;                        // s1 / s01 / s01e..
  if(new RegExp(`(?:season|сезон|сезону|сезоні)\\s*0*${season}\\b`, 'i').test(s))return true; // season 1 / сезон 1
  if(new RegExp(`\\b0*${season}\\s*(?:season|сезон)`, 'i').test(s))return true;               // 1 season / 1 сезон
  const range = s.match(/s0*(\d+)\s*[-–—]?\s*s0*(\d+)/);
  if(range && season >= parseInt(range[1]) && season <= parseInt(range[2]))return true;      // s01-s03
  return false;
}

// Does the name mention ANY season marker? Distinguishes a single-season / whole-show pack (no
// marker) from an explicit different-season pack.
function nameMentionsAnySeason(name){
  return /(?:season|сезон)\s*\d|\bs\d{1,2}(?:\b|e)|\d\s*(?:season|сезон)/i.test(`${name}`);
}

function getSlowIndexerStats(indexerId){
  slowIndexers[indexerId] = (slowIndexers[indexerId] || []).filter(item => new Date() - item.date < config.slowIndexerWindow);
  return {
    min: Math.min(...slowIndexers[indexerId].map(item => item.duration)),
    avg: Math.round(slowIndexers[indexerId].reduce((acc, item) => acc + item.duration, 0) / slowIndexers[indexerId].length),
    max: Math.max(...slowIndexers[indexerId].map(item => item.duration)),
    count: slowIndexers[indexerId].length
  }
}

async function timeoutIndexerSearch(indexerId, promise, timeout){
  const start = new Date();
  const res = await promiseTimeout(promise, timeout).catch(err => []);
  const duration = new Date() - start;
  if(timeout > config.slowIndexerDuration){
    if(duration > config.slowIndexerDuration){
      console.log(`Slow indexer detected : ${indexerId} : ${duration}ms`);
      slowIndexers[indexerId].push({duration, date: new Date()});
    }else{
      slowIndexers[indexerId] = [];
    }
  }
  return res;
}

async function getTorrents(userConfig, metaInfos, debridInstance){

  while(actionInProgress.getTorrents[metaInfos.stremioId]){
    await wait(500);
  }
  actionInProgress.getTorrents[metaInfos.stremioId] = true;

  try {

    const {qualities, excludeKeywords, maxTorrents, sortCached, sortUncached, priotizePackTorrents, priotizeLanguages, indexerTimeoutSec} = userConfig;
    const {id, season, episode, type, stremioId, year} = metaInfos;

    let torrents = [];
    let startDate = new Date();

    console.log(`${stremioId} : Searching torrents ...`);

    const sortSearch = [['seeders', true]];
    const filterSearch = (torrent) => {
      if(!qualities.includes(torrent.quality))return false;
      const torrentWords = parseWords(torrent.name.toLowerCase());
      if(excludeKeywords.find(word => torrentWords.includes(word)))return false;
      return true;
    };
    const filterLanguage = (torrent) => {
      if(priotizeLanguages.length == 0)return true;
      return torrent.languages.find(lang => ['multi'].concat(priotizeLanguages).includes(lang.value));
    };
    const filterYear = (torrent) => !torrent.year || torrent.year == year;
    const filterSlowIndexer = (indexer) => config.slowIndexerRequest <= 0 || getSlowIndexerStats(indexer.id).count < config.slowIndexerRequest;

    let indexers = (await jackett.getIndexers());
    let availableIndexers = indexers.filter(indexer => indexer.searching[type].available);
    let availableFastIndexers = availableIndexers.filter(filterSlowIndexer);
    if(availableFastIndexers.length)availableIndexers = availableFastIndexers;
    let userIndexers = availableIndexers.filter(indexer => (userConfig.indexers.includes(indexer.id) || userConfig.indexers.includes('all')));

    if(userIndexers.length){
      indexers = userIndexers;
    }else if(availableIndexers.length){
      console.log(`${stremioId} : User defined indexers "${userConfig.indexers.join(', ')}" not available, fallback to all "${type}" indexers`);
      indexers = availableIndexers;
    }else if(indexers.length){
      console.log(`${stremioId} : User defined indexers "${userConfig.indexers.join(', ')}" or "${type}" indexers not available, fallback to all indexers`);
    }else{
      throw new Error(`${stremioId} : No indexer configured in jackett`);
    }

    console.log(`${stremioId} : ${indexers.length} indexers selected : ${indexers.map(indexer => indexer.title).join(', ')}`);

    if(type == 'movie'){

      const promises = indexers.map(indexer => timeoutIndexerSearch(indexer.id, jackett.searchMovieTorrents({...metaInfos, indexer: indexer.id}), indexerTimeoutSec*1000));
      torrents = [].concat(...(await Promise.all(promises)));

      console.log(`${stremioId} : ${torrents.length} torrents found in ${(new Date() - startDate) / 1000}s`);

      const yearTorrents = torrents.filter(filterYear);
      if(yearTorrents.length)torrents = yearTorrents;
      torrents = torrents.filter(filterSearch).sort(sortBy(...sortSearch));
      torrents = priotizeItems(torrents, filterLanguage, Math.max(1, Math.round(maxTorrents * 0.33)));
      torrents = torrents.slice(0, maxTorrents + 2);

    }else if(type == 'series'){

      const episodesPromises = indexers.map(indexer => timeoutIndexerSearch(indexer.id, jackett.searchEpisodeTorrents({...metaInfos, indexer: indexer.id}), indexerTimeoutSec*1000));
      // const packsPromises = indexers.map(indexer => promiseTimeout(jackett.searchSeasonTorrents({...metaInfos, indexer: indexer.id}), indexerTimeoutSec*1000).catch(err => []));
      const packsPromises = indexers.map(indexer => timeoutIndexerSearch(indexer.id, jackett.searchSerieTorrents({...metaInfos, indexer: indexer.id}), indexerTimeoutSec*1000));

      const rawEpisodes = [].concat(...(await Promise.all(episodesPromises)));
      const rawPacks = [].concat(...(await Promise.all(packsPromises)));
      const episodesTorrents = rawEpisodes.filter(filterSearch);
      // const packsTorrents = [].concat(...(await Promise.all(packsPromises))).filter(torrent => filterSearch(torrent) && parseWords(torrent.name.toUpperCase()).includes(`S${numberPad(season)}`));
      const packsTorrents = rawPacks.filter(torrent => {
        if(!filterSearch(torrent))return false;
        const words = parseWords(torrent.name.toLowerCase());
        const wordsStr = words.join(' ');
        if(
          // Season x
          wordsStr.includes(`season ${season}`)
          // SXX
          || words.includes(`s${numberPad(season)}`)
        ){
          return true;
        }
        // From SXX to SXX
        const range = wordsStr.match(/s([\d]{2,}) s([\d]{2,})/);
        if(range && season >= parseInt(range[1]) && season <= parseInt(range[2])){
          return true;
        }
        // Complete without season number (serie pack)
        if(words.includes('complete') && !wordsStr.match(/ (s[\d]{2,}|season [\d]) /)){
          return true;
        }
        return false;
      });

      torrents = [].concat(episodesTorrents, packsTorrents);

      // Fallback: strict episode/season matching found nothing, but the indexer DID return quality-
      // passing results. This happens when packs are titled in another language (e.g. Toloka's
      // Cyrillic "Сезон 1", which parseWords strips) or as a marker-less single-season pack. Recover
      // any result that matches THIS season (language-tolerant) or carries no season marker at all,
      // while still excluding results that explicitly belong to a DIFFERENT season. The right episode
      // file is picked from the pack at play time.
      if(torrents.length === 0){
        const seen = new Set();
        torrents = [...rawEpisodes, ...rawPacks].filter(torrent => {
          if(!filterSearch(torrent))return false;
          if(!(nameMatchesSeason(torrent.name, season) || !nameMentionsAnySeason(torrent.name)))return false;
          const key = (torrent.infoHash || '') || torrent.id;
          if(seen.has(key))return false;
          seen.add(key);
          return true;
        });
        if(torrents.length)console.log(`${stremioId} : strict match empty; language-tolerant season match recovered ${torrents.length} of ${rawEpisodes.length + rawPacks.length} raw results`);
      }

      console.log(`${stremioId} : ${torrents.length} torrents found in ${(new Date() - startDate) / 1000}s`);

      // Diagnostic: still nothing usable — say WHY so it's actionable from the logs.
      if(torrents.length === 0){
        const raw = [...rawEpisodes, ...rawPacks];
        if(raw.length > 0){
          const failedQuality = raw.filter(t => !qualities.includes(t.quality)).length;
          if(failedQuality === raw.length){
            const qualitiesSeen = [...new Set(raw.map(t => t.quality))].sort((a, b) => a - b);
            console.log(`${stremioId} : all ${raw.length} results dropped by the quality filter. Your qualities=[${qualities.join(',')}], results have qualities=[${qualitiesSeen.join(',')}]. Enable the missing quality in /configure (or set DEFAULT_QUALITIES).`);
          }else{
            console.log(`${stremioId} : ${raw.length} results but none matched season ${season} for "${metaInfos.name}". Sample names: ${raw.slice(0, 6).map(t => t.name).join(' | ')}`);
          }
        }else{
          console.log(`${stremioId} : indexers returned 0 results for "${metaInfos.name}" S${numberPad(season)}E${numberPad(episode)} (cat=tv). The tracker may title the show differently or not expose it under TV search.`);
        }
      }

      const yearTorrents = torrents.filter(filterYear);
      if(yearTorrents.length)torrents = yearTorrents;
      torrents = torrents.filter(filterSearch).sort(sortBy(...sortSearch));
      torrents = priotizeItems(torrents, filterLanguage, Math.max(1, Math.round(maxTorrents * 0.33)));
      torrents = torrents.slice(0, maxTorrents + 2);

      if(priotizePackTorrents > 0 && packsTorrents.length && !torrents.find(t => packsTorrents.includes(t))){
        const bestPackTorrents = packsTorrents.slice(0, Math.min(packsTorrents.length, priotizePackTorrents));
        torrents.splice(bestPackTorrents.length * -1, bestPackTorrents.length, ...bestPackTorrents);
      }

    }

    console.log(`${stremioId} : ${torrents.length} torrents filtered, get torrents infos ...`);
    startDate = new Date();

    const limit = pLimit(5);
    torrents = await Promise.all(torrents.map(torrent => limit(async () => {
      try {
        torrent.infos = await promiseTimeout(torrentInfos.get(torrent), Math.min(30, indexerTimeoutSec)*1000);
        return torrent;
      }catch(err){
        console.log(`${stremioId} Failed getting torrent infos for ${torrent.id} from indexer ${torrent.indexerId}`);
        console.log(`${stremioId} ${torrent.link.replace(/apikey=[a-z0-9\-]+/, 'apikey=****')}`, err);
        return false;
      }
    })));
    torrents = torrents.filter(torrent => torrent && torrent.infos)
      .filter((torrent, index, items) => items.findIndex(t => t.infos.infoHash == torrent.infos.infoHash) === index)
      .slice(0, maxTorrents);

    console.log(`${stremioId} : ${torrents.length} torrents infos found in ${(new Date() - startDate) / 1000}s`);

    if(torrents.length == 0){
      throw new Error(`No torrent infos for type ${type} and id ${stremioId}`);
    }

    if(debridInstance){

      try {

        const isValidCachedFiles = type == 'series' ? files => !!searchEpisodeFile(files, season, episode) : files => true;
        const cachedTorrents = (await debridInstance.getTorrentsCached(torrents, isValidCachedFiles)).map(torrent => {
          torrent.isCached = true;
          return torrent;
        });
        const uncachedTorrents = torrents.filter(torrent => cachedTorrents.indexOf(torrent) === -1);

        if(config.replacePasskey && !(userConfig.passkey && userConfig.passkey.match(new RegExp(config.replacePasskeyPattern)))){
          uncachedTorrents.forEach(torrent => {
            if(torrent.infos.private){
              torrent.disabled = true;
              torrent.infoText = 'Uncached torrent require a passkey configuration';
            }
          });
        }

        console.log(`${stremioId} : ${cachedTorrents.length} cached torrents on ${debridInstance.shortName}`);

        torrents = priotizeItems(cachedTorrents.sort(sortBy(...sortCached)), filterLanguage);

        if(!userConfig.hideUncached || !debrid.cacheCheckAvailable){
          torrents.push(...priotizeItems(uncachedTorrents.sort(sortBy(...sortUncached)), filterLanguage));
        }
      
        const progress = await debridInstance.getProgressTorrents(torrents);
        torrents.forEach(torrent => {
          torrent.progress = progress[torrent.infos.infoHash] || null;
          // Present in the debrid account's list (getProgressTorrents covers the whole account list)
          // → it's already "my media", so streams can flag it (📁).
          torrent.inAccount = !!progress[torrent.infos.infoHash];
        });

      }catch(err){

        console.log(`${stremioId} : ${debridInstance.shortName} : ${err.message || err}`);

        if(err.message == debrid.ERROR.EXPIRED_API_KEY){
          torrents.forEach(torrent => {
            torrent.disabled = true;
            torrent.infoText = 'Unable to verify cache (+): Expired Debrid API Key.';
          });
        }

      }

    }

    return torrents;

  }finally{

    delete actionInProgress.getTorrents[metaInfos.stremioId];

  }

}

async function prepareNextEpisode(userConfig, metaInfos, debridInstance){

  try {

    const {stremioId} = metaInfos;
    const nextEpisodeIndex = metaInfos.episodes.findIndex(e => e.episode == metaInfos.episode && e.season == metaInfos.season) + 1;
    const nextEpisode = metaInfos.episodes[nextEpisodeIndex] || false;

    if(nextEpisode){

      metaInfos = await meta.getEpisodeById(metaInfos.id, nextEpisode.season, nextEpisode.episode, userConfig.metaLanguage);
      const torrents = await getTorrents(userConfig, metaInfos, debridInstance);

      // Cache next episode on debrid when not cached
      if(userConfig.forceCacheNextEpisode && torrents.length && !torrents.find(torrent => torrent.isCached)){
        console.log(`${stremioId} : Force cache next episode (${metaInfos.episode}) on debrid`);
        const bestTorrent = torrents.find(torrent => !torrent.disabled);
        if(bestTorrent)await getDebridFiles(userConfig, bestTorrent.infos, debridInstance);
      }

    }

  }catch(err){

    if(err.message != debrid.ERROR.NOT_READY){
      console.log('cache next episode:', err);
    }

  }

}

async function getDebridFiles(userConfig, infos, debridInstance){

  if(infos.magnetUrl){

    return debridInstance.getFilesFromMagnet(infos.magnetUrl, infos.infoHash);

  }else{

    let buffer = await torrentInfos.getTorrentFile(infos);

    if(config.replacePasskey){

      if(infos.private && !userConfig.passkey){
        return debridInstance.getFilesFromHash(infos.infoHash);
      }

      if(!userConfig.passkey.match(new RegExp(config.replacePasskeyPattern))){
        throw new Error(`Invalid user passkey, pattern not match: ${config.replacePasskeyPattern}`);
      }

      const from = buffer.toString('binary');
      let to = from.replace(new RegExp(config.replacePasskey, 'g'), userConfig.passkey);
      const diffLength = from.length - to.length;
      const announceLength = from.match(/:announce([\d]+):/);
      if(diffLength && announceLength && announceLength[1]){
        to = to.replace(announceLength[0], `:announce${parseInt(announceLength[1]) - diffLength}:`);
      }
      buffer = Buffer.from(to, 'binary');

    }

    return debridInstance.getFilesFromBuffer(buffer, infos.infoHash);

  }

}

function getFile(files, type, season, episode){
  files = files.sort(sortBy('size', true));
  if(type == 'movie'){
    return files[0];
  }else if(type == 'series'){
    return searchEpisodeFile(files, season, episode) || files[0];
  }
}

// Pick the episode file (same choice as getFile / playback) and flag whether its name STRONGLY
// matches the requested SxxExx / NxNN — so the stream list can show ✅ (identified) vs ⚠️ (best
// guess / first file). Empty files (e.g. an unparsed public magnet) → no file, not confident.
function matchEpisodeFile(files, season, episode){
  const chosen = getFile(files || [], 'series', season, episode) || null;
  if(!chosen)return {file: null, exact: false};
  const exactRe = new RegExp(`(?:s0*${season}[ ._-]*e0*${episode}|\\b${season}x0*${episode})\\b`, 'i');
  return {file: chosen, exact: exactRe.test(chosen.name || '')};
}

export async function getStreams(userConfig, type, stremioId, publicUrl){

  userConfig = await mergeDefaultUserConfig(userConfig);
  const {id, season, episode} = parseStremioId(stremioId);
  const debridInstance = debrid.instance(userConfig);

  let metaInfos = await getMetaInfos(type, stremioId, userConfig.metaLanguage);

  // Fetch the IMDb / Rotten Tomatoes rating in parallel with the (slow) torrent search so it adds
  // no latency; it's the same for every stream of this title/episode, so we fetch it once.
  const ratingPromise = rating.getRatingLine({imdbId: metaInfos.imdb_id || metaInfos.id, type, season, episode}).catch(() => '');

  const torrents = await getTorrents(userConfig, metaInfos, debridInstance);

  // Prepare next expisode torrents list
  if(type == 'series'){
    prepareNextEpisode({...userConfig, forceCacheNextEpisode: false}, metaInfos, debridInstance);
  }

  const ratingLine = await ratingPromise;

  return torrents.map(torrent => {
    const files = torrent.infos.files || [];
    const quality = torrent.quality > 0 ? config.qualities.find(q => q.value == torrent.quality).label : '';
    const totalSize = torrent.infos.size > 0 ? torrent.infos.size : torrent.size;
    const meta = [`👥${torrent.seeders}`, `⚙️${torrent.indexerId}`, ...(torrent.languages || []).map(language => language.emoji)].join(' ');

    let file;
    const rows = [];
    // Rating on top (⭐ IMDb / 🍅 Rotten Tomatoes), same for every stream of this title/episode.
    if(ratingLine)rows.push(ratingLine);

    if(type == 'series'){
      // Status line on top: ✅/⚠️ episode marker + episode size / whole-torrent size, so it's easy to
      // confirm the right episode and see how big the single file vs. the full download is.
      const {file: epFile, exact} = matchEpisodeFile(files, season, episode);
      file = epFile || {};
      const isPack = files.length > 1 && file.size > 0 && file.size < totalSize;
      const sizeStr = file.size > 0
        ? (isPack ? `${bytesToSize(file.size)} / ${bytesToSize(totalSize)}` : bytesToSize(file.size))
        : bytesToSize(totalSize);
      rows.push(`${exact ? '✅' : '⚠️'} S${numberPad(season)}E${numberPad(episode)} · ${sizeStr}`);
      if(file.name)rows.push(file.name);
      rows.push(meta);
      if(torrent.infoText)rows.push(`ℹ️ ${torrent.infoText}`);
      if(torrent.progress && !torrent.isCached)rows.push(`⬇️ ${torrent.progress.percent}% ${bytesToSize(torrent.progress.speed)}/s`);
      rows.push(torrent.name);
    }else{
      file = getFile(files, type, season, episode) || {};
      rows.push(torrent.name);
      if(torrent.infoText)rows.push(`ℹ️ ${torrent.infoText}`);
      rows.push([`💾${bytesToSize(file.size || torrent.size)}`, meta].join(' '));
      if(torrent.progress && !torrent.isCached)rows.push(`⬇️ ${torrent.progress.percent}% ${bytesToSize(torrent.progress.speed)}/s`);
    }

    return {
      name: `[${debridInstance.shortName}${torrent.isCached ? '+' : ''}${torrent.inAccount ? '📁' : ''}] ${userConfig.enableMediaFlow ? '🕵🏼‍♂️ ' : ''}${config.addonName} ${quality}`,
      title: rows.join("\n"),
      url: torrent.disabled ? '#' : `${publicUrl}/${btoa(JSON.stringify(userConfig))}/download/${type}/${stremioId}/${torrent.id}/${file.name || torrent.name}`
    };
  });

}

export async function getDownload(userConfig, type, stremioId, torrentId){

  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);
  const infos = await torrentInfos.getById(torrentId);
  const {id, season, episode} = parseStremioId(stremioId);
  const cacheKey = `download:2:${await debridInstance.getUserHash()}${userConfig.enableMediaFlow ? ':mfp': ''}:${stremioId}:${torrentId}`;
  let files;
  let download;
  let waitMs = 0;

  while(actionInProgress.getDownload[cacheKey]){
    await wait(Math.min(300, waitMs+=50));
  }
  actionInProgress.getDownload[cacheKey] = true;

  try {

    // Prepare next expisode debrid cache
    if(type == 'series' && userConfig.forceCacheNextEpisode){
      getMetaInfos(type, stremioId, userConfig.metaLanguage).then(metaInfos => prepareNextEpisode(userConfig, metaInfos, debridInstance));
    }

    download = await cache.get(cacheKey);
    if(download)return download;

    console.log(`${stremioId} : ${debridInstance.shortName} : ${infos.infoHash} : get files ...`);
    files = await getDebridFiles(userConfig, infos, debridInstance);
    console.log(`${stremioId} : ${debridInstance.shortName} : ${infos.infoHash} : ${files.length} files found`);


    download = await debridInstance.getDownload(getFile(files, type, season, episode));

    if(download){
      download = applyMediaflowProxyIfNeeded(download, userConfig);
      await cache.set(cacheKey, download, {ttl: 3600});
      return download;
    }

    throw new Error(`No download for type ${type} and ID ${torrentId}`);

  }finally{

    delete actionInProgress.getDownload[cacheKey];

  }

}