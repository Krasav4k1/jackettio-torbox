import config from './config.js';
import cache from './cache.js';
import {promiseTimeout} from './util.js';

// Fetch and normalize a title's full OMDb record by IMDb id (movie / whole title) or by
// id + season + episode (a specific series episode). Returns null when OMDb isn't configured, the
// title can't be found, or on error. Cached for a day (negative results cached too).
export async function getById(imdbId, {season, episode} = {}){
  imdbId = `${imdbId || ''}`;
  if(!config.omdbApiKey || !imdbId.startsWith('tt'))return null;

  const isEpisode = season != null && episode != null;
  const cacheKey = `omdb:1:${imdbId}${isEpisode ? `:${season}:${episode}` : ''}`;
  const cached = await cache.get(cacheKey);
  if(cached !== undefined)return cached;

  const data = await promiseTimeout(fetchOmdb(imdbId, {season, episode, isEpisode}), 3000).catch(() => null);
  const record = data ? normalize(data) : null;
  await cache.set(cacheKey, record, {ttl: 3600 * 24});
  return record;
}

async function fetchOmdb(imdbId, {season, episode, isEpisode}){
  const params = new URLSearchParams({apikey: config.omdbApiKey, i: imdbId, plot: 'full', r: 'json'});
  if(isEpisode){
    params.set('Season', `${season}`);
    params.set('Episode', `${episode}`);
  }
  const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`, {headers: {accept: 'application/json'}});
  if(!res.ok)return null;
  const data = await res.json();
  return data && data.Response !== 'False' ? data : null;
}

const clean = v => (v && v !== 'N/A' ? `${v}`.trim() : null);
const toList = v => {
  const c = clean(v);
  return c ? c.split(',').map(s => s.trim()).filter(Boolean) : [];
};

function normalize(d){
  let rt = null;
  for(const r of (d.Ratings || [])){
    if(r.Source === 'Rotten Tomatoes'){
      rt = r.Value;
      break;
    }
  }
  return {
    name: clean(d.Title),
    imdbId: clean(d.imdbID),
    type: d.Type === 'series' ? 'series' : 'movie',
    year: clean(d.Year),
    released: clean(d.Released),   // e.g. "05 May 2017"
    runtime: clean(d.Runtime),     // e.g. "136 min"
    genres: toList(d.Genre),
    director: toList(d.Director),
    writer: toList(d.Writer),
    cast: toList(d.Actors),
    plot: clean(d.Plot),
    country: clean(d.Country),
    language: clean(d.Language),
    awards: clean(d.Awards),
    poster: clean(d.Poster),
    imdbRating: clean(d.imdbRating),
    imdbVotes: clean(d.imdbVotes),
    rt,
    mc: clean(d.Metascore)
  };
}

// Map an OMDb record onto Stremio meta fields. Cast / director / writer / genres are emitted via
// the `links` array (the modern, non-deprecated path that current clients render) AND via the
// legacy `cast`/`director`/`writer`/`genres` fields for older clients — this mirrors what Stremio's
// own Cinemeta addon does, including the exact link categories it uses ("Cast", "Directors",
// "Writers", "Genres", "imdb"), which every client is known to render.
// See https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/meta.md
export function stremioMetaFields(record){
  if(!record)return {};
  const out = {};
  const search = name => `stremio:///search?search=${encodeURIComponent(name)}`;

  // Links: {name, category, url}, grouped by category on the detail page. Order/categories match
  // Cinemeta so the sections render the same way.
  const links = [];
  if(record.imdbRating && record.imdbId)links.push({name: record.imdbRating, category: 'imdb', url: `https://www.imdb.com/title/${record.imdbId}`});
  for(const name of record.genres)links.push({name, category: 'Genres', url: search(name)});
  for(const name of record.director)links.push({name, category: 'Directors', url: search(name)});
  for(const name of record.writer)links.push({name, category: 'Writers', url: search(name)});
  for(const name of record.cast)links.push({name, category: 'Cast', url: search(name)});
  if(links.length)out.links = links;

  // Legacy fields (deprecated but still rendered by older clients).
  if(record.cast.length)out.cast = record.cast;
  if(record.director.length)out.director = record.director;
  if(record.writer.length)out.writer = record.writer;
  if(record.genres.length)out.genres = record.genres;

  if(record.runtime)out.runtime = record.runtime;
  if(record.imdbRating)out.imdbRating = record.imdbRating;
  if(record.country)out.country = record.country;
  if(record.awards)out.awards = record.awards;
  if(record.year)out.releaseInfo = record.year;
  if(record.released){
    const t = Date.parse(record.released);
    if(!isNaN(t))out.released = new Date(t).toISOString();
  }
  return out;
}
