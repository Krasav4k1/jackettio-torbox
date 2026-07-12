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

// Best-effort poster lookup by name via Cinemeta's free search catalog. Returns a poster URL
// or null. Results (including "not found") are cached to avoid repeated lookups on reload.
export async function searchPoster(name){
  const {title, year} = parseTitleFromName(name);
  if(!title)return null;

  const cacheKey = `poster:${title.toLowerCase()}:${year || ''}`;
  const cached = await cache.get(cacheKey);
  if(cached !== undefined)return cached || null;

  let poster = null;
  try {
    // Prefer TMDB when a token is configured (better search), then fall back to Cinemeta.
    if(config.tmdbAccessToken){
      poster = await promiseTimeout(searchTmdb(title, year), 3000).catch(() => null);
    }
    if(!poster){
      // Try the full title, then progressively drop trailing words (junk that survived parsing).
      outer:
      for(const query of titleQueries(title)){
        for(const type of ['movie', 'series']){
          const metas = await promiseTimeout(searchCinemeta(type, query), 3000).catch(() => []);
          let match = metas[0];
          if(year){
            const byYear = metas.find(m => `${m.releaseInfo || ''}`.startsWith(`${year}`));
            if(byYear)match = byYear;
          }
          if(match && match.poster){
            poster = match.poster;
            break outer;
          }
        }
      }
    }
  }catch(err){
    poster = null;
  }

  await cache.set(cacheKey, poster || '', {ttl: 3600 * 24 * 7});
  return poster;
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