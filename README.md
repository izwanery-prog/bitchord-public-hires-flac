# BitChord Public Hi-Res FLAC Add-on

A small Node.js 20+ HTTP add-on for BitChord 1.9.1. It searches Internet Archive audio items and only exposes items whose metadata declares a permissive Creative Commons licence (CC0, Public Domain Mark, CC BY, CC BY-SA) or explicitly states public domain / no known copyright. It selects actual `.flac` files and never transcodes MP3/AAC into fake lossless audio.

## Important quality limitation

The add-on offers a Hi-Res selection (up to 24-bit/192 kHz), but public-domain catalogues do not guarantee that every recording exists at that resolution. The server reads the FLAC STREAMINFO header and reports sample rate/bit depth only when it can verify them. Some recordings may be CD-quality 16/44.1 or may have unknown metadata. A FLAC file is lossless relative to that file; it does not prove that the original recording/master was lossless.

## Run locally

Requires Node.js 20 or newer. No npm packages are required.

```bash
npm start
```

The server listens on `http://localhost:8080` by default. Test:

```bash
curl http://localhost:8080/manifest.json
curl 'http://localhost:8080/search?q=Beethoven&quality=hires'
```

## Connect to BitChord

BitChord needs a publicly reachable **HTTPS** URL. `localhost` will only work on the same device and is not a public deployment.

1. Deploy this folder to a Node.js host that supports Node 20 (for example, a VPS with Caddy, or another HTTPS-capable Node host).
2. Set the host's start command to `npm start` and expose its assigned port (the app reads `PORT`).
3. Confirm `https://YOUR-HOST/manifest.json` returns JSON.
4. On Android, open **BitChord → Settings → Sources → Add an addon**.
5. Paste `https://YOUR-HOST` (or `https://YOUR-HOST/manifest.json`), tap **Test**, then save.
6. Under the add-on's quality setting, select **Hi-Res FLAC**.

## Behaviour and limitations

- Search is limited to public/openly licensed Internet Archive audio metadata and FLAC files.
- Availability, rights metadata, and resolution depend on the uploader and Internet Archive.
- Some Archive FLAC files may be whole-album recordings rather than individual tracks.
- Direct Archive download URLs are used for playback; Archive availability and bandwidth are outside this add-on's control.
- This starter version omits BitChord's optional v1.9.1 hardware-backed add-on authentication. BitChord may show an **Outdated addon** note, but the documented protocol allows non-authenticated add-ons to continue working. Do not treat the manifest flag alone as security; proper authentication requires the official verifier and your deployed hostname.
- The `checkValidLossless` gate is off by default so the source remains discoverable on all outputs. Bit-perfect playback still depends on the Android audio path, DAC, output mode, and source file.

## Environment

- `PORT` (default `8080`)
- `SEARCH_LIMIT` (default `12`, maximum `25`)

## Licence

This add-on code is provided under MIT. The recordings it discovers are separately governed by their own Internet Archive item licences; check the item page before reuse or redistribution.
