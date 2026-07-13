import cacheManager from 'cache-manager';
import config from './config.js';
import {wait} from './util.js';

// Store selection:
// 1. An external Redis (Upstash / Vercel KV / self-host) when REDIS_URL or KV_URL is set — it
//    persists across serverless cold starts AND redeploys, and is shared across all instances.
// 2. Otherwise on serverless (Vercel), an in-memory store — ephemeral, but the filesystem is
//    read-only/ephemeral and native sqlite3 is fragile there. Losing it is only a speed hit.
// 3. Otherwise (self-host/Docker), SQLite on disk.
const redisUrl = process.env.REDIS_URL || process.env.KV_URL || '';
const useMemoryStore = !redisUrl && (!!process.env.VERCEL || process.env.CACHE_STORE === 'memory');

let db = null;
let cache;

if(redisUrl){
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