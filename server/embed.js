'use strict';

/**
 * Server-side fetch of Spotify's embed pages. The parsing itself lives in
 * public/lib/embed-parser.js so the browser can reuse it in static mode.
 */

const parser = require('../public/lib/embed-parser.js');

const { EmbedError, embedUrl, parseEmbedHtml } = parser;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Fetch the embed page for { type, id } and parse it.
 * @param {{type:string,id:string}} ref
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 */
async function fetchEmbed(ref, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const url = embedUrl(ref);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en' },
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs || 10000),
    });
  } catch (err) {
    throw new EmbedError('upstream', `Could not reach Spotify (${err && err.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
  }
  if (res.status === 404) throw new EmbedError('not_found', 'Spotify could not find that link.');
  if (!res.ok) throw new EmbedError('upstream', `Spotify responded with HTTP ${res.status}.`);
  let html;
  try {
    html = await res.text(); // the timeout signal also covers reading the body
  } catch (err) {
    throw new EmbedError('upstream', `Could not read Spotify's response (${err && err.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
  }
  return parseEmbedHtml(html, ref.type);
}

module.exports = { ...parser, fetchEmbed };
