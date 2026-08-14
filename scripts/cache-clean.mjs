#!/usr/bin/env node
// Inspect and clean the addon's cache (Upstash REST or a TCP Redis).
//
//   npm run cache:clean                          # read-only: key counts per prefix
//   npm run cache:clean -- --all                 # delete everything
//   npm run cache:clean -- --prefix torrentInfos: --prefix jackettItems:
//   npm run cache:clean -- --all --dry-run       # show what would go, delete nothing
//
// Everything the addon stores is a cache with a TTL, so deleting is always safe — it refills on
// demand. Reads credentials from the environment, or from a .env file in the project root.

import {readFileSync, existsSync} from 'fs';
import path from 'path';

const ROOT = path.join(import.meta.dirname, '..');

// Minimal .env reader so `npm run cache:clean` works locally without exporting anything.
// Existing environment variables always win.
export function loadDotEnv(file){
  if(!existsSync(file))return {};
  const env = {};
  for(const line of readFileSync(file, 'utf8').split('\n')){
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if(!match)continue;
    let value = match[2].trim();
    if((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))){
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

export function parseArgs(argv){
  const opts = {prefixes: [], all: false, dryRun: false};
  for(let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if(arg === '--all')opts.all = true;
    else if(arg === '--dry-run')opts.dryRun = true;
    else if(arg === '--prefix')opts.prefixes.push(argv[++i]);
    else if(arg.startsWith('--prefix='))opts.prefixes.push(arg.slice('--prefix='.length));
  }
  return opts;
}

// Namespaces whose second segment is a real sub-namespace worth keeping apart in the stats
// (jackettio:group vs jackettio:torrent, torbox:mylist vs torbox:playurl). Everywhere else the
// second segment is a value — an id, title or version — so it collapses to a single row.
const SUB_NAMESPACED = new Set(['jackettio', 'torbox', 'torboxmovie', 'torboxseries']);

// Group keys for the stats view: keep the namespace, collapse the variable part.
export function groupKey(key){
  const parts = `${key}`.split(':');
  if(parts.length === 1)return parts[0];
  if(SUB_NAMESPACED.has(parts[0]) && parts.length > 2)return `${parts[0]}:${parts[1]}:*`;
  return `${parts[0]}:*`;
}

export function summarize(keys){
  const counts = {};
  for(const key of keys)counts[groupKey(key)] = (counts[groupKey(key)] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Walk SCAN to completion. `client` only needs {scan(cursor, match, count) -> [cursor, keys]}.
export async function scanAll(client, match = '*'){
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, match, 500);
    cursor = `${next}`;
    keys.push(...(batch || []));
  } while(cursor !== '0');
  return keys;
}

export async function deleteKeys(client, keys, {dryRun = false} = {}){
  if(dryRun || !keys.length)return 0;
  let deleted = 0;
  for(let i = 0; i < keys.length; i += 200){ // chunk so a single command stays small
    deleted += (await client.del(keys.slice(i, i + 200))) || 0;
  }
  return deleted;
}

// One tiny interface over both stores, so the logic above stays store-agnostic.
async function connect(env){
  const restUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '';
  const restToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  const redisUrl = env.REDIS_URL || env.KV_URL || '';

  if(restUrl && restToken){
    const {Redis} = await import('@upstash/redis');
    const client = new Redis({url: restUrl, token: restToken});
    return {
      name: `upstash-rest (${restUrl.replace(/^https?:\/\//, '')})`,
      scan: async (cursor, match, count) => client.scan(cursor, {match, count}),
      del: async (keys) => client.del(...keys),
      dbsize: () => client.dbsize(),
      flushdb: () => client.flushdb(),
      close: async () => {}
    };
  }

  if(redisUrl){
    const Redis = (await import('ioredis')).default;
    const client = new Redis(redisUrl, {maxRetriesPerRequest: 3});
    return {
      name: `redis (${redisUrl.replace(/:\/\/.*@/, '://***@')})`,
      scan: async (cursor, match, count) => client.scan(cursor, 'MATCH', match, 'COUNT', count),
      del: async (keys) => client.del(...keys),
      dbsize: () => client.dbsize(),
      flushdb: () => client.flushdb(),
      close: async () => client.quit()
    };
  }

  return null;
}

async function main(){
  const env = Object.assign(loadDotEnv(path.join(ROOT, '.env')), process.env);
  const opts = parseArgs(process.argv.slice(2));

  const client = await connect(env);
  if(!client){
    console.error('No cache configured. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or REDIS_URL)');
    console.error('in the environment or in a .env file at the project root.');
    process.exit(1);
  }

  console.log(`Cache store: ${client.name}`);
  const total = await client.dbsize();
  console.log(`Keys: ${total}`);

  // Read-only by default: a bare `npm run cache:clean` must never delete anything.
  if(!opts.all && !opts.prefixes.length){
    const rows = summarize(await scanAll(client, '*'));
    if(rows.length){
      console.log('\nKeys by prefix:');
      for(const [prefix, count] of rows)console.log(`  ${String(count).padStart(6)}  ${prefix}`);
    }
    console.log('\nNothing deleted. Re-run with --all, or --prefix <prefix> (add --dry-run to preview).');
    await client.close();
    return;
  }

  if(opts.all){
    if(opts.dryRun){
      console.log(`\n[dry run] would flush all ${total} keys`);
    }else{
      await client.flushdb();
      console.log(`\nFlushed all ${total} keys`);
    }
  }else{
    for(const prefix of opts.prefixes){
      const keys = await scanAll(client, `${prefix}*`);
      const deleted = await deleteKeys(client, keys, {dryRun: opts.dryRun});
      console.log(`${opts.dryRun ? '[dry run] would delete' : 'Deleted'} ${opts.dryRun ? keys.length : deleted} key(s) matching "${prefix}*"`);
    }
  }

  console.log(`Keys remaining: ${await client.dbsize()}`);
  await client.close();
}

// Only run when invoked directly, so the helpers above stay importable for tests.
if(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)){
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
