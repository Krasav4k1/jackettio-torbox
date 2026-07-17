import config from './config.js';
import cache from './cache.js';
import {promiseTimeout} from './util.js';

// Build a compact rating string (e.g. "⭐ 8.1  🍅 93%") to prepend to a stream title, for a movie
// or a specific series episode. Best-effort and cached; returns '' when nothing is available so
// callers can prepend it unconditionally.
//
// Two sources:
//   * OMDb (needs a free OMDB_API_KEY) — IMDb rating + Rotten Tomatoes, and true per-episode IMDb
//     ratings for series. Only source with Rotten Tomatoes.
//   * Cinemeta (free, no key) — movie / show-level IMDb rating only; used as a fallback. Rotten
//     Tomatoes and per-episode ratings are not available here.
export async function getRatingLine({imdbId, type, season, episode}){
  imdbId = `${imdbId || ''}`;
  if(!imdbId.startsWith('tt'))return '';

  const isEpisode = type === 'series' && season != null && episode != null;
  const cacheKey = `rating:2:${imdbId}${isEpisode ? `:${season}:${episode}` : ''}`;
  const cached = await cache.get(cacheKey);
  if(cached !== undefined)return cached;

  let imdb = null;
  let rt = null;
  let mc = null;

  // Prefer OMDb when configured — the only free source with Rotten Tomatoes / Metacritic and
  // per-episode IMDb. All three ratings come back in the single OMDb call.
  if(config.omdbApiKey){
    const omdb = await promiseTimeout(fetchOmdb({imdbId, season, episode, isEpisode}), 3000).catch(() => null);
    if(omdb){
      imdb = omdb.imdb;
      rt = omdb.rt;
      mc = omdb.mc;
    }
  }

  // Fallback to Cinemeta's free meta for a movie/show-level IMDb rating when OMDb gave nothing.
  if(imdb == null){
    imdb = await promiseTimeout(fetchCinemetaRating({imdbId, type}), 3000).catch(() => null);
  }

  const line = formatRating(imdb, rt, mc);
  // Ratings drift slowly; cache for a day (misses cached too, so we don't refetch on every open).
  await cache.set(cacheKey, line, {ttl: 3600 * 24});
  return line;
}

function formatRating(imdb, rt, mc){
  const parts = [];
  if(imdb)parts.push(`⭐ ${imdb}`);        // IMDb (audience, /10)
  if(rt)parts.push(`🍅 ${rt}`);            // Rotten Tomatoes (critics, %)
  if(mc)parts.push(`Ⓜ️ ${mc}`);            // Metacritic (weighted critics, /100)
  return parts.join('  ');
}

async function fetchOmdb({imdbId, season, episode, isEpisode}){
  const params = new URLSearchParams({apikey: config.omdbApiKey, i: imdbId, r: 'json'});
  if(isEpisode){
    params.set('Season', `${season}`);
    params.set('Episode', `${episode}`);
  }
  const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`, {headers: {accept: 'application/json'}});
  if(!res.ok)return null;
  const data = await res.json();
  if(!data || data.Response === 'False')return null;
  const imdb = data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null;
  let rt = null;
  for(const r of (data.Ratings || [])){
    if(r.Source === 'Rotten Tomatoes'){
      rt = r.Value;
      break;
    }
  }
  // Metacritic comes as a top-level "Metascore" (e.g. "67") — show it as-is (out of 100).
  const mc = data.Metascore && data.Metascore !== 'N/A' ? data.Metascore : null;
  return {imdb, rt, mc};
}

async function fetchCinemetaRating({imdbId, type}){
  const kind = type === 'series' ? 'series' : 'movie';
  const res = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, {headers: {accept: 'application/json'}});
  if(!res.ok)return null;
  const data = await res.json();
  const r = data && data.meta ? data.meta.imdbRating : null;
  return r && r !== 'N/A' ? r : null;
}
