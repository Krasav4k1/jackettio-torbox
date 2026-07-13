import config from './config.js';
import cache from './cache.js';
import {promiseTimeout} from './util.js';
import Cinemeta from './meta/cinemeta.js';
import Tmdb from './meta/tmdb.js';

const client = config.tmdbAccessToken ? new Tmdb() : new Cinemeta();

export async function getMovieById(id, language){
  return client.getMovieById(id, language);
}

export async function getEpisodeById(id, season, episode, language){
  return client.getEpisodeById(id, season, episode, language);
}

export async function getLanguages(){
  return client.getLanguages();
}

// Release group / quality / source tokens that mark the end of a title in a torrent name.
const TITLE_JUNK = /\b(2160p|1080p|720p|480p|360p|4k|uhd|hdr|bluray|blu-ray|web-?dl|web-?rip|webrip|hdrip|dvdrip|bdrip|brrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|xvid|aac|ac3|dts|ddp?5|remux|proper|repack|multi|dual|complete|season|s\d{1,2}(e\d{1,3})?)\b/i;

// Best-effort: extract a clean {title, year} from a raw torrent/file name.
export function parseTitleFromName(name){
  let s = `${name}`.replace(/[._]+/g, ' ').replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  const yearMatch = s.match(/\b(19|20)\d{2}\b/);
  let cut = s.length;
  const junk = s.search(TITLE_JUNK);
  if(junk >= 0)cut = Math.min(cut, junk);
  if(yearMatch)cut = Math.min(cut, yearMatch.index);
  let title = s.slice(0, cut).trim();
  if(!title)title = s.trim();
  return {title, year: yearMatch ? parseInt(yearMatch[0]) : null};
}

// Best-effort lookup by name via Cinemeta's free search catalog (which yields both a poster and
// the IMDb id) plus TMDB for a poster when configured. Returns {poster, imdbId} (either may be
// null). Results (including misses) are cached to avoid repeated lookups on reload.
export async function searchInfo(name, hintType){
  const {title, year} = parseTitleFromName(name);
  if(!title)return {poster: null, imdbId: null, name: null};

  // Series and movies with the same title resolve to different entries, so key (and search) by the
  // hinted type. Movie / unhinted lookups keep the original key so their cache isn't invalidated.
  const cacheKey = `info:${hintType === 'series' ? 'series:' : ''}${title.toLowerCase()}:${year || ''}`;
  const cached = await cache.get(cacheKey);
  if(cached !== undefined)return cached;

  // Search the hinted type first so a series doesn't get matched to a same-named movie (and vice
  // versa). Unhinted lookups keep movie-first (the previous behaviour).
  const searchTypes = hintType === 'series' ? ['series', 'movie'] : ['movie', 'series'];

  let poster = null;
  let imdbId = null;
  let matchedName = null;
  try {
    // Cinemeta search gives the poster, the tt id and the canonical name. Try the full title,
    // then progressively drop trailing words (junk that survived parsing).
    outer:
    for(const query of titleQueries(title)){
      for(const type of searchTypes){
        const metas = await promiseTimeout(searchCinemeta(type, query), 3000).catch(() => []);
        let match = metas[0];
        if(year){
          const byYear = metas.find(m => `${m.releaseInfo || ''}`.startsWith(`${year}`));
          if(byYear)match = byYear;
        }
        if(match){
          if(`${match.id || ''}`.startsWith('tt'))imdbId = match.id;
          if(match.poster)poster = match.poster;
          if(match.name)matchedName = match.name;
          if(poster || imdbId)break outer;
        }
      }
    }
    // TMDB can provide a nicer poster when configured; keep the Cinemeta tt id.
    if(config.tmdbAccessToken && !poster){
      poster = await promiseTimeout(searchTmdb(title, year), 3000).catch(() => null);
    }
  }catch(err){
    // keep whatever we found
  }

  const result = {poster: poster || null, imdbId: imdbId || null, name: matchedName || null};
  await cache.set(cacheKey, result, {ttl: 3600 * 24 * 7});
  return result;
}

// Full title, then shrinking prefixes (down to 2 words) to survive trailing junk in names.
function titleQueries(title){
  const words = title.split(' ').filter(Boolean);
  const queries = [title];
  for(let n = words.length - 1; n >= 2; n--){
    queries.push(words.slice(0, n).join(' '));
  }
  return [...new Set(queries)];
}

async function searchCinemeta(type, query){
  const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
  const res = await fetch(url, {headers: {accept: 'application/json'}});
  if(!res.ok)return [];
  const data = await res.json();
  return data.metas || [];
}

async function searchTmdb(query, year){
  const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}${year ? `&year=${year}` : ''}`;
  const res = await fetch(url, {headers: {accept: 'application/json', authorization: `Bearer ${config.tmdbAccessToken}`}});
  if(!res.ok)return null;
  const data = await res.json();
  const results = (data.results || []).filter(r => r.poster_path && (r.media_type === 'movie' || r.media_type === 'tv'));
  if(!results.length)return null;
  let match = results[0];
  if(year){
    const byYear = results.find(r => `${r.release_date || r.first_air_date || ''}`.startsWith(`${year}`));
    if(byYear)match = byYear;
  }
  return `https://image.tmdb.org/t/p/w500${match.poster_path}`;
}