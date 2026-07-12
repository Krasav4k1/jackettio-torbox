import {createHash} from 'crypto';
import {basename} from 'path';
import {ERROR} from './const.js';

export default class TorBox {

  static id = 'torbox';
  static name = 'TorBox';
  static shortName = 'TB';
  static cacheCheckAvailable = true;
  static configFields = [
    {
      type: 'text',
      name: 'debridApiKey',
      label: `TorBox API Key`,
      required: true,
      href: {value: 'https://torbox.app/settings', label:'Get API Key Here'}
    }
  ];

  #apiKey;
  #ip;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.#apiKey = userConfig.debridApiKey;
    this.#ip = userConfig.ip || '';
  }

  async getTorrentsCached(torrents, isValidCachedFiles){
    const hashList = torrents.map(torrent => torrent.infos.infoHash).filter(Boolean);
    if(!hashList.length)return [];
    const body = JSON.stringify({hashes: hashList});
    const res = await this.#request('POST', '/torrents/checkcached', {
      body,
      headers: {'content-type': 'application/json'},
      query: {format: 'object', list_files: 'true'}
    });
    // data is an object keyed by hash. Normalize keys to lowercase for matching.
    const cached = {};
    for(const [hash, value] of Object.entries(res.data || {})){
      cached[hash.toLowerCase()] = value;
    }
    return torrents.filter(torrent => {
      const value = cached[(torrent.infos.infoHash || '').toLowerCase()];
      if(!value)return false;
      const files = (value.files || []).map(file => ({name: file.name, size: file.size}));
      return isValidCachedFiles(files);
    });
  }

  async getProgressTorrents(torrents){
    const res = await this.#request('GET', '/torrents/mylist', {query: {bypass_cache: 'true'}});
    return (res.data || []).reduce((progress, torrent) => {
      progress[torrent.hash] = {
        // TorBox progress is a ratio between 0 and 1
        percent: Math.round((torrent.progress || 0) * 100),
        speed: torrent.download_speed || 0
      }
      return progress;
    }, {});
  }

  async getFilesFromHash(infoHash){
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash){
    const body = new FormData();
    body.append('magnet', magnet);
    const res = await this.#request('POST', `/torrents/createtorrent`, {body});
    return this.#getFilesFromTorrent(res.data.torrent_id);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const body = new FormData();
    body.append('file', new Blob([buffer]), 'file.torrent');
    const res = await this.#request('POST', `/torrents/createtorrent`, {body});
    return this.#getFilesFromTorrent(res.data.torrent_id);
  }

  async getDownload(file){

    const [torrentId, fileId] = file.id.split(':');
    const torrent = await this.#getTorrent(torrentId);

    if(!torrent || !torrent.download_present){
      throw new Error(ERROR.NOT_READY);
    }

    const res = await this.#request('GET', '/torrents/requestdl', {query: {
      token: this.#apiKey,
      torrent_id: torrentId,
      file_id: fileId,
      user_ip: this.#ip
    }});

    if(!res.data){
      throw new Error(`Unable to request TorBox download link: ${JSON.stringify(res)}`);
    }

    return res.data;

  }

  async getUserHash(){
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  async #getTorrent(torrentId){
    const res = await this.#request('GET', '/torrents/mylist', {query: {id: torrentId, bypass_cache: 'true'}});
    // With an id, TorBox returns a single object; without, an array. Handle both.
    if(Array.isArray(res.data)){
      return res.data.find(torrent => `${torrent.id}` == `${torrentId}`);
    }
    return res.data;
  }

  async #getFilesFromTorrent(torrentId){

    const torrent = await this.#getTorrent(torrentId);

    if(!torrent || !(torrent.files || []).length){
      throw new Error(ERROR.NOT_READY);
    }

    return torrent.files.map((file) => {
      return {
        name: file.short_name || basename(file.name),
        size: file.size,
        id: `${torrent.id}:${file.id}`,
        url: '',
        ready: !!torrent.download_present
      };
    });

  }

  async #request(method, path, opts){

    opts = opts || {};
    opts = Object.assign(opts, {
      method,
      headers: Object.assign({
        'accept': 'application/json',
        'authorization': `Bearer ${this.#apiKey}`
      }, opts.headers || {}),
      query: opts.query || {}
    });

    const url = `https://api.torbox.app/v1/api${path}?${new URLSearchParams(opts.query).toString()}`;
    const res = await fetch(url, opts);
    let data;

    try {
      data = await res.json();
    }catch(err){
      data = res.status >= 400 ? {success: false, error: 'UNKNOWN_ERROR', detail: `Empty response ${res.status}`} : {success: true};
    }

    if(!data.success){
      console.log(data);
      switch(data.error || ''){
        case 'BAD_TOKEN':
        case 'AUTH_ERROR':
        case 'MISSING_TOKEN':
        case 'NO_AUTH':
          throw new Error(ERROR.EXPIRED_API_KEY);
        case 'PLAN_RESTRICTED_FEATURE':
        case 'ACTIVE_LIMIT':
        case 'MONTHLY_LIMIT':
        case 'COOLDOWN_LIMIT':
        case 'DOWNLOAD_TOO_LARGE':
          throw new Error(ERROR.NOT_PREMIUM);
        default:
          throw new Error(`Invalid TB api result: ${JSON.stringify(data)}`);
      }
    }

    return data;

  }

}
