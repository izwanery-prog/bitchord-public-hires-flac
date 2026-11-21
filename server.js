import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
const USER_AGENT = 'BitChord-HiRes-Public-Addon/1.0 (personal music discovery)';
const SEARCH_LIMIT = Math.min(Number(process.env.SEARCH_LIMIT || 12), 25);
const CACHE_MS = 5 * 60 * 1000;
const searchCache = new Map();
const itemCache = new Map();

const manifest = {
  id: 'com.ery.bitchord.public-hires-flac',
  name: 'Public Hi-Res FLAC',
  version: '1.0.0',
  description: 'Openly licensed FLAC recordings from Internet Archive. Actual source quality is reported per file.',
  resources: ['search', 'stream'],
  allowDownloads: 1,
  checkValidLossless: 0,
  settings: [{
    key: 'quality', type: 'select', label: 'Audio quality', default: 'hires',
    options: [
      { value: 'hires', label: 'Hi-Res FLAC (up to 24-bit / 192 kHz)' },
      { value: 'lossless', label: 'Lossless FLAC (any resolution)' },
      { value: 'high', label: 'High (fallback to next BitChord source)' }
    ]
  }]
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Upstream returned HTTP ${r.status}`);
  return r.json();
}

function allowedLicense(meta) {
  const m = meta.metadata || {};
  const licence = String(m.licenseurl || m.license || '').toLowerCase();
  const rights = String(m.rights || '').toLowerCase();
  return licence.includes('creativecommons.org/publicdomain/zero') ||
    licence.includes('creativecommons.org/publicdomain/mark') ||
    /creativecommons\.org\/licenses\/(by|by-sa)\//.test(licence) ||
    rights.includes('public domain') || rights.includes('no known copyright');
}

function pickFlacFiles(meta) {
  return (meta.files || []).filter(f =>
    typeof f.name === 'string' && f.name.toLowerCase().endsWith('.flac') &&
    f.source !== 'metadata' && f.size && !String(f.name).startsWith('__ia_')
  );
}

function niceTitle(fileName, fallback) {
  const base = fileName.split('/').pop().replace(/\.flac$/i, '');
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback || 'Untitled recording';
}

async function getItem(identifier) {
  const cached = itemCache.get(identifier);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  const value = { meta, files: pickFlacFiles(meta), permitted: allowedLicense(meta) };
  itemCache.set(identifier, { at: Date.now(), value });
  return value;
}

async function searchTracks(query, quality) {
  const key = `${query.toLowerCase()}|${quality}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const safeQuery = query.replace(/["\\]/g, ' ').trim();
  const q = `mediatype:audio AND (${safeQuery.split(/\s+/).filter(Boolean).map(w => `(${w})`).join(' AND ')})`;
  const params = new URLSearchParams({ q, fl: 'identifier,title,creator', rows: String(SEARCH_LIMIT * 3), page: '1', output: 'json', sort: 'downloads desc' });
  const data = await getJson(`https://archive.org/advancedsearch.php?${params}`);
  const docs = data.response?.docs || [];
  const tracks = [];

  for (const doc of docs) {
    if (tracks.length >= SEARCH_LIMIT) break;
    try {
      const item = await getItem(doc.identifier);
      if (!item.permitted) continue;
      for (const file of item.files) {
        if (tracks.length >= SEARCH_LIMIT) break;
        const id = `${doc.identifier}::${file.name}`;
        const title = niceTitle(file.name, doc.title);
        const track = {
          id,
          title,
          artist: Array.isArray(doc.creator) ? doc.creator.join(', ') : (doc.creator || 'Internet Archive contributor'),
          album: doc.title || doc.identifier,
          duration: Number(file.length) || undefined,
          artworkURL: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
          format: 'flac',
          audioQuality: 'LOSSLESS'
        };
        tracks.push(track);
      }
    } catch (e) {
      // Skip unavailable or malformed archive items; continue with other results.
    }
  }
  const result = { tracks };
  searchCache.set(key, { at: Date.now(), value: result });
  return result;
}

function decodeTrackId(raw) {
  const split = raw.indexOf('::');
  if (split < 1) return null;
  const identifier = raw.slice(0, split);
  const filename = raw.slice(split + 2);
  if (!/^[a-zA-Z0-9._-]+$/.test(identifier) || !filename || filename.includes('..') || filename.startsWith('/')) return null;
  return { identifier, filename };
}

async function flacInfo(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-63', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
    if (!r.ok && r.status !== 206) return {};
    const b = Buffer.from(await r.arrayBuffer());
    if (b.toString('ascii', 0, 4) !== 'fLaC' || b.length < 26) return {};
    const blockType = b[4] & 0x7f;
    if (blockType !== 0) return {};
    const packed = b.readBigUInt64BE(18);
    const sampleRate = Number((packed >> 44n) & 0xfffffn);
    const bitDepth = Number(((packed >> 36n) & 0x1fn) + 1n);
    return { sampleRate: sampleRate || undefined, bitDepth: bitDepth || undefined };
  } catch { return {}; }
}

async function streamInfo(rawId, quality) {
  const parsed = decodeTrackId(rawId);
  if (!parsed) return null;
  const item = await getItem(parsed.identifier);
  if (!item.permitted) return null;
  const file = item.files.find(f => f.name === parsed.filename);
  if (!file) return null;
  const direct = `https://archive.org/download/${encodeURIComponent(parsed.identifier)}/${parsed.filename.split('/').map(encodeURIComponent).join('/')}`;
  const info = await flacInfo(direct);
  // Never advertise a Hi-Res rate unless it is verified from the FLAC STREAMINFO block.
  if (quality === 'hires' && info.sampleRate && (info.sampleRate > 192000 || info.bitDepth > 24)) return null;
  const labels = info.sampleRate && info.bitDepth
    ? `FLAC · ${info.bitDepth}-bit / ${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 ? 1 : 0)} kHz`
    : 'FLAC · lossless (resolution not verified)';
  return {
    url: direct,
    format: 'flac', quality: labels, codec: 'flac', container: 'flac', manifest: 'none', encrypted: false,
    ...(info.sampleRate ? { sampleRate: info.sampleRate } : {}),
    ...(info.bitDepth ? { bitDepth: info.bitDepth } : {}),
    ...(Number(file.size) ? { bitrate: undefined } : {})
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' }, { allow: 'GET' });
    if (url.pathname === '/' || url.pathname === '/manifest.json') return send(res, 200, manifest);
    if (url.pathname === '/health') return send(res, 200, { ok: true, addon: manifest.id, version: manifest.version });
    if (url.pathname === '/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const quality = (url.searchParams.get('quality') || 'hires').toLowerCase();
      if (q.length < 2) return send(res, 200, { tracks: [] });
      if (quality === 'high' || quality === 'low') return send(res, 200, { tracks: [] });
      return send(res, 200, await searchTracks(q, quality));
    }
    if (url.pathname.startsWith('/stream/')) {
      const rawId = decodeURIComponent(url.pathname.slice('/stream/'.length));
      const info = await streamInfo(rawId, (url.searchParams.get('quality') || 'hires').toLowerCase());
      return info ? send(res, 200, info) : send(res, 404, { error: 'No openly licensed FLAC rendition found.' });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, 502, { error: 'Catalogue temporarily unavailable. Please retry.' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`BitChord Public Hi-Res FLAC addon listening on ${PORT}`));
