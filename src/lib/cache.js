import cacheManager from 'cache-manager';
import config from './config.js';
import {wait} from './util.js';

// On serverless platforms (Vercel) the filesystem is ephemeral/read-only and the native
// sqlite3 module is fragile, so fall back to an in-memory store. The cache is only a speed
// optimization, so losing it between cold starts is harmless. Self-host/Docker keeps SQLite.
const useMemoryStore = !!process.env.VERCEL || process.env.CACHE_STORE === 'memory';

let db = null;
let cache;

if(useMemoryStore){
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