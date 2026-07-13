import cacheManager from 'cache-manager';
import config from './config.js';
import {wait} from './util.js';

// Store selection, in priority order:
// 1. Upstash REST (UPSTASH_REDIS_REST_URL/TOKEN or Vercel KV's KV_REST_API_URL/TOKEN) — the
//    recommended client for serverless (HTTP, no TCP connection limits). Auto-injected by the
//    Upstash/Vercel integration, so it "just works" after a redeploy.
// 2. A TCP Redis (REDIS_URL or KV_URL, e.g. rediss://…) via ioredis.
// 3. On serverless (Vercel) with no Redis, an in-memory store — ephemeral (lost on cold
//    start/redeploy, not shared across instances), but the FS is read-only and sqlite3 is fragile.
// 4. Otherwise (self-host/Docker), SQLite on disk.
// Options 1 & 2 persist across cold starts AND redeploys and are shared across all instances.
const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const redisUrl = process.env.REDIS_URL || process.env.KV_URL || '';
const useMemoryStore = !restUrl && !redisUrl && (!!process.env.VERCEL || process.env.CACHE_STORE === 'memory');

let db = null;
let cache;

if(restUrl && restToken){
  const {Redis} = await import('@upstash/redis');
  const client = new Redis({url: restUrl, token: restToken});
  // Minimal adapter — the app only uses get/set. @upstash/redis auto-serializes JSON; normalize a
  // null miss to undefined so callers that check `=== undefined` behave like the other stores.
  cache = {
    async get(key){ const value = await client.get(key); return value === null || value === undefined ? undefined : value; },
    async set(key, value, opts){ const ttl = opts && opts.ttl; return ttl ? client.set(key, value, {ex: ttl}) : client.set(key, value); },
    async del(key){ return client.del(key); }
  };
  console.log('Cache store: upstash-rest');
}else if(redisUrl){
  const Redis = (await import('ioredis')).default;
  const redisStore = (await import('cache-manager-ioredis')).default;
  const client = new Redis(redisUrl, {maxRetriesPerRequest: 3, enableReadyCheck: true, connectTimeout: 10000});
  client.on('error', err => console.log(`cache redis error: ${err.message}`));
  cache = await cacheManager.caching({store: redisStore, redisInstance: client, ttl: 86400});
  // Redis returns null on a miss; memory/sqlite return undefined. Normalize so callers that check
  // `=== undefined` (e.g. the negative-cache in meta.searchInfo) behave the same on every store.
  const rawGet = cache.get.bind(cache);
  cache.get = async (...args) => {
    const value = await rawGet(...args);
    return value === null ? undefined : value;
  };
  console.log('Cache store: redis');
}else if(useMemoryStore){
  cache = await cacheManager.caching({store: 'memory', max: 5000, ttl: 86400});
}else{
  const sqlite3 = (await import('sqlite3')).default;
  const sqliteStore = (await import('cache-manager-sqlite')).default;
  db = new sqlite3.Database(`${config.dataFolder}/cache.db`);
  cache = await cacheManager.caching({
    store: sqliteStore,
    path: `${config.dataFolder}/cache.db`,
    options: { ttl: 86400 }
  });
}

export default cache;

export async function clean(){
  // https://github.com/maxpert/node-cache-manager-sqlite/blob/36a1fe44a30b6af8d8c323c59e09fe81bde539d9/index.js#L146
  // The cache will grow until an expired key is requested
  // This hack should force node-cache-manager-sqlite to purge
  await cache.set('_clean', 'todo', {ttl: 1});
  await wait(3e3);
  await cache.get('_clean');
}

export async function vacuum(){
  if(!db)return;
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('VACUUM', err => {
        if(err)return reject(err);
        resolve();
      })
    });
  });
}