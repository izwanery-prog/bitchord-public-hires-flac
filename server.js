
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
const USER_AGENT = 'BitChord-Public-HiRes-FLAC/2.1.0';
const SEARCH_LIMIT = Math.min(
  Math.max(Number(process.env.SEARCH_LIMIT || 12), 1),
  25
);
const CACHE_MS = 5 * 60 * 1000;

const searchCache = new Map();
const itemCache = new Map();

const manifest = {
  id: 'com.ery.bitchord.public-hires-flac',
  name: 'Public Hi-Res FLAC',
  version: '2.1.0',
  description: 'Publicly licensed FLAC recordings with verified 24-bit and Hi-Res audio support.',
  resources: ['search', 'stream'],
  allowDownloads: 1,
  checkValidLossless: 0,
  settings: [{
    key: 'quality',
    type: 'select',
    label: 'Audio quality',
    default: '24bit',
    options: [
      {
        value: 'hires',
        label: 'Strict Hi-Res (24-bit / 96–192 kHz)'
      },
      {
        value: '24bit',
        label: '24-bit FLAC (44.1–192 kHz)'
      },
      {
        value: 'lossless',
        label: 'Lossless FLAC (any resolution)'
      },
      {
        value: 'high',
        label: 'High (fallback to next BitChord source)'
      }
    ]
  }]
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string'
    ? data
    : JSON.stringify(data);

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });

  res.end(body);
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }

  return response.json();
}

function trimCache(cache, maxSize = 500) {
  while (cache.size > maxSize) {
    cache.delete(cache.keys().next().value);
  }
}

function allowedLicense(meta) {
  const m = meta.metadata || {};

  const licence = String(
    m.licenseurl || m.license || ''
  ).toLowerCase();

  const rights = String(m.rights || '').toLowerCase();

  return (
    licence.includes('creativecommons.org/publicdomain/zero') ||
    licence.includes('creativecommons.org/publicdomain/mark') ||
    /creativecommons\.org\/licenses\/(by|by-sa)\//.test(licence) ||
    rights.includes('public domain') ||
    rights.includes('no known copyright')
  );
}

function pickFlacFiles(meta) {
  return (meta.files || []).filter(file =>
    typeof file.name === 'string' &&
    file.name.toLowerCase().endsWith('.flac') &&
    file.source !== 'metadata' &&
    Number(file.size) > 0 &&
    !file.name.startsWith('__ia_')
  );
}

function niceTitle(fileName, fallback) {
  const base = fileName
    .split('/')
    .pop()
    .replace(/\.flac$/i, '');

  return base
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fallback || 'Untitled recording';
}

async function getItem(identifier) {
  const cached = itemCache.get(identifier);

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }

  const meta = await getJson(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`
  );

  const value = {
    meta,
    files: pickFlacFiles(meta),
    permitted: allowedLicense(meta)
  };

  itemCache.set(identifier, {
    at: Date.now(),
    value
  });

  trimCache(itemCache);

  return value;
}

function makeDirectUrl(identifier, filename) {
  const encodedName = filename
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodedName}`;
}

async function readFirstBytes(response, wanted = 64) {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < wanted) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  return Buffer.concat(chunks).subarray(0, wanted);
}

/*
 * Verify FLAC STREAMINFO.
 * Reads the actual file header, not just the filename.
 */
async function flacInfo(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Range: 'bytes=0-63',
        'User-Agent': USER_AGENT
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok && response.status !== 206) {
      return {};
    }

    const b = await readFirstBytes(response, 64);

    if (
      b.length < 26 ||
      b.toString('ascii', 0, 4) !== 'fLaC'
    ) {
      return {};
    }

    const blockType = b[4] & 0x7f;
    const blockLength = b.readUIntBE(5, 3);

    if (blockType !== 0 || blockLength !== 34) {
      return {};
    }

    const packed = b.readBigUInt64BE(18);

    const sampleRate = Number(
      (packed >> 44n) & 0xfffffn
    );

    const bitDepth = Number(
      ((packed >> 36n) & 0x1fn) + 1n
    );

    if (
      !sampleRate ||
      !bitDepth ||
      sampleRate > 768000 ||
      bitDepth > 32
    ) {
      return {};
    }

    return {
      sampleRate,
      bitDepth
    };

  } catch {
    return {};
  }
}

function isStrictHiRes(info) {
  return (
    info.sampleRate >= 96000 &&
    info.sampleRate <= 192000 &&
    info.bitDepth === 24
  );
}

function is24Bit(info) {
  return (
    info.sampleRate >= 44100 &&
    info.sampleRate <= 192000 &&
    info.bitDepth === 24
  );
}

function isVerifiedLossless(info) {
  return (
    info.sampleRate > 0 &&
    info.bitDepth > 0
  );
}

function resolutionLabel(info) {
  if (!isVerifiedLossless(info)) {
    return 'FLAC · resolution not verified';
  }

  const khz = info.sampleRate / 1000;

  const rate = Number.isInteger(khz)
    ? khz.toFixed(0)
    : khz.toFixed(1);

  return `FLAC · ${info.bitDepth}-bit / ${rate} kHz`;
}

/*
 * Higher bit depth and sample rate are prioritised.
 */
function qualityRank(info) {
  return (
    info.bitDepth * 1000000 +
    info.sampleRate
  );
}

function qualityAllowed(info, quality) {
  if (quality === 'hires') {
    return isStrictHiRes(info);
  }

  if (quality === '24bit') {
    return is24Bit(info);
  }

  if (quality === 'lossless') {
    return isVerifiedLossless(info);
  }

  return false;
}

/*
 * Search Internet Archive.
 * Verify FLAC files before returning tracks.
 */
async function searchTracks(query, quality) {
  const key = `${query.toLowerCase()}|${quality}`;

  const cached = searchCache.get(key);

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }

  const safeQuery = query
    .replace(/["\\]/g, ' ')
    .trim();

  const words = safeQuery
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) {
    return { tracks: [] };
  }

  const q =
    `mediatype:audio AND (` +
    words.map(word => `(${word})`).join(' AND ') +
    `)`;

  const params = new URLSearchParams({
    q,
    fl: 'identifier,title,creator',
    rows: String(Math.min(SEARCH_LIMIT * 6, 100)),
    page: '1',
    output: 'json',
    sort: 'downloads desc'
  });

  const data = await getJson(
    `https://archive.org/advancedsearch.php?${params}`
  );

  const docs = data.response?.docs || [];

  const candidates = [];
  const seen = new Set();

  const maxCandidates = SEARCH_LIMIT * 3;

  for (const doc of docs) {
    if (candidates.length >= maxCandidates) break;

    try {
      const item = await getItem(doc.identifier);

      if (!item.permitted) continue;

      for (const file of item.files) {
        if (candidates.length >= maxCandidates) break;

        const id = `${doc.identifier}::${file.name}`;

        if (seen.has(id)) continue;

        seen.add(id);

        const direct = makeDirectUrl(
          doc.identifier,
          file.name
        );

        const info = await flacInfo(direct);

        if (!qualityAllowed(info, quality)) {
          continue;
        }

        candidates.push({
          id,
          title: niceTitle(file.name, doc.title),
          artist: Array.isArray(doc.creator)
            ? doc.creator.join(', ')
            : (doc.creator || 'Internet Archive contributor'),
          album: doc.title || doc.identifier,
          artworkURL:
            `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
          format: 'flac',
          audioQuality: 'LOSSLESS',
          sampleRate: info.sampleRate,
          bitDepth: info.bitDepth,
          qualityLabel: resolutionLabel(info),
          rank: qualityRank(info)
        });
      }

    } catch (error) {
      console.error(
        `Skipping archive item ${doc.identifier}:`,
        error.message
      );
    }
  }

  candidates.sort((a, b) => b.rank - a.rank);

  const tracks = candidates
    .slice(0, SEARCH_LIMIT)
    .map(({ rank, ...track }) => track);

  const result = { tracks };

  searchCache.set(key, {
    at: Date.now(),
    value: result
  });

  trimCache(searchCache);

  return result;
}

function decodeTrackId(raw) {
  const split = raw.indexOf('::');

  if (split < 1) return null;

  const identifier = raw.slice(0, split);
  const filename = raw.slice(split + 2);

  if (
    !/^[a-zA-Z0-9._-]+$/.test(identifier) ||
    !filename ||
    filename.includes('..') ||
    filename.startsWith('/') ||
    filename.includes('\\')
  ) {
    return null;
  }

  return {
    identifier,
    filename
  };
}

/*
 * Verify the requested track again before streaming.
 */
async function streamInfo(rawId, quality) {
  const parsed = decodeTrackId(rawId);

  if (!parsed) return null;

  const item = await getItem(parsed.identifier);

  if (!item.permitted) return null;

  const file = item.files.find(
    f => f.name === parsed.filename
  );

  if (!file) return null;

  const direct = makeDirectUrl(
    parsed.identifier,
    parsed.filename
  );

  const info = await flacInfo(direct);

  if (!qualityAllowed(info, quality)) {
    return null;
  }

  return {
    url: direct,
    format: 'flac',
    quality: resolutionLabel(info),
    codec: 'flac',
    container: 'flac',
    manifest: 'none',
    encrypted: false,
    sampleRate: info.sampleRate,
    bitDepth: info.bitDepth
  };
}

function validQuality(quality) {
  return [
    'hires',
    '24bit',
    'lossless'
  ].includes(quality);
}

const server = http.createServer(async (req, res) => {
  let url;

  try {
    url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );
  } catch {
    return send(res, 400, {
      error: 'Invalid request URL.'
    });
  }

  try {
    if (req.method !== 'GET') {
      return send(
        res,
        405,
        { error: 'GET only' },
        { allow: 'GET' }
      );
    }

    /*
     * Manifest
     */
    if (
      url.pathname === '/' ||
      url.pathname === '/manifest.json'
    ) {
      return send(res, 200, manifest);
    }

    /*
     * Health check
     */
    if (url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        addon: manifest.id,
        version: manifest.version
      });
    }

    /*
     * Search
     */
    if (url.pathname === '/search') {
      const query = (
        url.searchParams.get('q') || ''
      ).trim();

      const quality = (
        url.searchParams.get('quality') || '24bit'
      ).toLowerCase();

      if (query.length < 2) {
        return send(res, 200, { tracks: [] });
      }

      /*
       * Let BitChord use its next source.
       */
      if (quality === 'high') {
        return send(res, 200, { tracks: [] });
      }

      if (!validQuality(quality)) {
        return send(res, 400, {
          error: 'Unsupported quality setting.'
        });
      }

      const result = await searchTracks(
        query,
        quality
      );

      return send(res, 200, result);
    }

    /*
     * Stream information
     */
    if (url.pathname.startsWith('/stream/')) {
      let rawId;

      try {
        rawId = decodeURIComponent(
          url.pathname.slice('/stream/'.length)
        );
      } catch {
        return send(res, 400, {
          error: 'Invalid track ID.'
        });
      }

      const quality = (
        url.searchParams.get('quality') || '24bit'
      ).toLowerCase();

      if (!validQuality(quality)) {
        return send(res, 400, {
          error: 'Unsupported quality setting.'
        });
      }

      const info = await streamInfo(
        rawId,
        quality
      );

      return info
        ? send(res, 200, info)
        : send(res, 404, {
            error: 'No verified FLAC file matching the selected quality was found.'
          });
    }

    return send(res, 404, {
      error: 'Not found'
    });

  } catch (error) {
    console.error('Request error:', error);

    return send(res, 502, {
      error: 'Catalogue temporarily unavailable. Please retry.'
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `BitChord Public Hi-Res FLAC v2.1.0 listening on ${PORT}`
  );
});
