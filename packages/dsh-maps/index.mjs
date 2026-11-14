import Schema from '@deepseek-ai/schemastery';
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT } from './remote.mjs';

export const name = 'dsh-maps';
export const inject = ['typert'];
export const Config = Schema.object({
  photonURL: Schema.string().default('https://photon.komoot.io/api').description('Photon search endpoint'),
  tileURL: Schema.string().default('https://tile.openstreetmap.org/{z}/{x}/{y}.png').description('OpenStreetMap tile URL template'),
});

function labelOf(properties) {
  const raw = [properties.street, properties.housenumber].filter(Boolean).join(' ');
  return [...new Set([raw, properties.district, properties.city, properties.state, properties.country].filter(Boolean))].join(', ');
}

function readPlaces(response) {
  if (!Array.isArray(response?.features)) return [];
  return response.features.slice(0, 15).flatMap((feature, index) => {
    const [lon, lat] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90) return [];
    const properties = feature.properties ?? {};
    const address = labelOf(properties);
    const name = properties.name || address;
    if (!name) return [];
    return [{
      id: String(index),
      name: String(name).slice(0, 180),
      address: String(address).slice(0, 360),
      kind: String(properties.osm_value || properties.type || '').replaceAll('_', ' ').slice(0, 80),
      lat,
      lon,
    }];
  });
}

const nearbyCategories = new Map([
  ['cafés', 'amenity:cafe'],
  ['restaurants', 'amenity:restaurant'],
  ['parks', 'leisure:park'],
  ['museums', 'tourism:museum'],
]);

function nearbyBounds(area) {
  const longitude = Math.min(1, 0.18 / Math.max(0.18, Math.cos(area.lat * Math.PI / 180)));
  return [
    Math.max(-180, area.lon - longitude), Math.max(-90, area.lat - 0.18),
    Math.min(180, area.lon + longitude), Math.min(90, area.lat + 0.18),
  ].join(',');
}

export async function searchPlaces(endpoint, request, signal) {
  const areaQuery = request.area.trim();
  const placeQuery = request.place.trim();
  if (!areaQuery || areaQuery.length > 180 || placeQuery.length > 180) throw new Error('Enter a valid area and place search.');
  const deadline = AbortSignal.timeout(8000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  async function lookup(url, parameters) {
    url.search = new URLSearchParams(parameters).toString();
    const response = await fetch(url, {
      signal: requestSignal,
      redirect: 'error',
      headers: {
        accept: 'application/geo+json, application/json',
        'user-agent': 'DSH-Workbench-Maps/0.1 (+https://github.com/federicobuilds/dsh-workbench)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('The place search service is unavailable.');
    }
    return readPlaces(await response.json());
  }
  const location = request.location;
  if (location && (!Number.isFinite(location.lat) || Math.abs(location.lat) > 90 ||
    !Number.isFinite(location.lon) || Math.abs(location.lon) > 180)) throw new Error('Invalid location.');
  const [area] = location ? [{ name: areaQuery, address: '', ...location }]
    : await lookup(new URL(endpoint), { q: areaQuery, limit: '1' });
  if (!area || !placeQuery) return { area: area ?? null, places: [], searchedNearby: false };
  const category = nearbyCategories.get(placeQuery.toLowerCase());
  const coordinates = { lat: String(area.lat), lon: String(area.lon), limit: '12' };
  const places = category
    ? await lookup(new URL('reverse', endpoint), { ...coordinates, radius: '12', osm_tag: category })
    : await lookup(new URL(endpoint), { ...coordinates, q: placeQuery, bbox: nearbyBounds(area) });
  return { area, places, searchedNearby: true };
}

export function apply(ctx, config = {}) {
  const endpoint = new URL(config.photonURL ?? 'https://photon.komoot.io/api');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) {
    throw new Error('Use an HTTPS Photon endpoint or a local HTTP endpoint.');
  }
  if (endpoint.username || endpoint.password) throw new Error('The Photon endpoint must not include credentials.');
  const tileURL = config.tileURL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const tileExample = new URL(tileURL.replace('{z}', '1').replace('{x}', '1').replace('{y}', '1'));
  if (tileExample.protocol !== 'https:' || tileExample.username || tileExample.password
    || !['{z}', '{x}', '{y}'].every(token => tileURL.includes(token))) {
    throw new Error('Use an HTTPS OpenStreetMap tile template containing {z}, {x}, and {y}.');
  }

  const initializers = [];
  class MapsService extends TypertRemoteService {
    constructor() {
      super(ctx, 'workbenchMaps');
      for (const initialize of initializers) initialize.call(this);
    }

    async search(request, signal) {
      if (!this.ctx.invocation || principalOf(this.ctx.invocation) !== undefined) {
        throw new RemoteError('gateway/bad-request', 'Only the owner UI may search places.');
      }
      try {
        return { ...await searchPlaces(endpoint, request, signal), tileURL };
      } catch (error) {
        signal?.throwIfAborted();
        throw new RemoteError('gateway/bad-request', error.name === 'TimeoutError'
          ? 'The place search timed out. Try again.'
          : 'Place search is unavailable. Check the Photon endpoint and try again.');
      }
    }
  }
  Remote(MapsService.prototype.search, {
    kind: 'method',
    name: 'search',
    static: false,
    private: false,
    addInitializer(fn) { initializers.push(fn); },
  });
  ctx.get('typert').register(TYPERT);
  new MapsService();
}
