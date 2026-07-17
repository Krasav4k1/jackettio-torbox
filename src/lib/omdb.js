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
// the `links` array (the `cast`/`director`/`genres` fields are deprecated in the Stremio meta
// spec, and modern clients only render these from `links`); the rest go on their own fields.
// Only includes fields that are present, so it can be spread into a meta object safely.
// See https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/meta.md
export function stremioMetaFields(record){
  if(!record)return {};
  const out = {};

  // A Stremio meta Link: {name, category, url}. Grouped by category on the detail page; the url is
  // an internal search link so the actor/director/etc. is clickable.
  const links = [];
  const addLinks = (names, category) => {
    for(const name of names)links.push({name, category, url: `stremio:///search?search=${encodeURIComponent(name)}`});
  };
  addLinks(record.cast, 'actor');
  addLinks(record.director, 'director');
  addLinks(record.writer, 'writer');
  addLinks(record.genres, 'genre');
  if(links.length)out.links = links;

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
