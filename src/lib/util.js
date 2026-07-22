import {setTimeout} from 'timers/promises';

export function numberPad(number, count){
  return `${number}`.padStart(count || 2, 0);
}

export function parseWords(str){
  return str.replace(/[^a-zA-Z0-9]+/g, ' ').split(' ').filter(Boolean);
}

export function sortBy(...keys){
  return (a, b) => {
    if(typeof(keys[0]) == 'string')keys = [keys];
    for(const [key, reverse] of keys){
      if(a[key] > b[key])return reverse ? -1 : 1;
      if(a[key] < b[key])return reverse ? 1 : -1;
    }
    return 0;
  }
}

export function bytesToSize(bytes){
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Byte';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return (Math.round(bytes / Math.pow(1024, i) * 100) / 100) + ' ' + sizes[i];
}

export function wait(ms){
  return setTimeout(ms);
}

// Best-effort video quality as a numeric height (2160/1080/720/480/360) parsed from a name, or 0
// when unknown. "4k"/"uhd" map to 2160. Used to order streams best-quality-first.
export function parseQuality(name){
  const m = `${name}`.match(/(2160|1080|720|480|360)p\b/i);
  if(m)return parseInt(m[1]);
  if(/\b(4k|uhd)\b/i.test(`${name}`))return 2160;
  return 0;
}

// A date-time as "YYYY-MM-DD HH:MM ET" in the America/New_York timezone (DST-aware; the tz label
// is EST/EDT), or '' when the value is missing/invalid.
export function formatDateTime(value){
  if(!value)return '';
  const t = Date.parse(value);
  if(isNaN(t))return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short'
  }).formatToParts(new Date(t));
  const get = type => (parts.find(part => part.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

export function isVideo(filename){
  return [
    "3g2",
    "3gp",
    "avi",
    "flv",
    "mkv",
    "mk3d",
    "mov",
    "mp2",
    "mp4",
    "m4v",
    "mpe",
    "mpeg",
    "mpg",
    "mpv",
    "webm",
    "wmv",
    "ogm",
    "ts",
    "m2ts"
  ].includes(filename?.split('.').pop());
}

export async function promiseTimeout(promise, ms){
  const ac = new AbortController();
  const waitPromise = setTimeout(ms, null, { signal: ac.signal }).then(() => Promise.reject(`Max execution time reached ${ms}`));
  return Promise.race([waitPromise, promise.finally(() => {
    ac.abort();
  })]);
}