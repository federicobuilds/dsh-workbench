window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-maps',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const panelId = 'workbench-maps';
    const attribution = 'https://www.openstreetmap.org/copyright';
    const tileSize = 256;
    const minZoom = 3;
    const maxZoom = 18;
    const css = `
.wb-maps{--maps-border:var(--dsw-alias-border-l1,#d4d4d8);--maps-card:var(--dsw-alias-bg-layer-1,#fff);--maps-text:var(--dsw-alias-label-primary,#18181b);--maps-muted:var(--dsw-alias-label-secondary,#5c5c65);box-sizing:border-box;width:100%;height:100%;overflow:auto;color:var(--maps-text);padding:clamp(16px,4vw,40px);font:inherit}
.wb-maps *{box-sizing:border-box}
.wb-maps-inner{width:min(100%,760px);margin:auto;display:grid;gap:24px}
.wb-maps h1,.wb-maps h2,.wb-maps p{margin:0}
.wb-maps h1{font-size:clamp(22px,4vw,32px);line-height:1.15;font-weight:650;letter-spacing:-.035em}
.wb-maps h2{font-size:14px;font-weight:650}
.wb-maps-description,.wb-maps .maps-muted{color:var(--maps-muted);font-size:12px;line-height:1.5}
.wb-maps-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:end}
.wb-maps label{display:grid;gap:5px;color:var(--maps-muted);font-size:12px}
.wb-maps input,.wb-maps button{min-height:36px;font:inherit;font-size:13px;color:inherit;border:1px solid var(--maps-border);background:var(--maps-card);border-radius:8px}
.wb-maps input{padding:7px 10px;width:100%;color:var(--maps-text)}
.wb-maps button{padding:6px 12px;cursor:pointer}
.wb-maps button:disabled{cursor:default;opacity:.55}
.wb-maps button:focus-visible,.wb-maps input:focus-visible,.wb-maps a:focus-visible,.wb-maps-map:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#147d6d);outline-offset:2px}
.wb-maps .maps-primary{background:#147d6d;color:#fff;border-color:#147d6d;font-weight:600}
.wb-maps-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,32%);gap:14px;align-items:stretch}
.wb-maps-body[data-single=true]{grid-template-columns:minmax(0,1fr)}
.wb-maps-map{position:relative;isolation:isolate;overflow:hidden;border:1px solid var(--maps-border);border-radius:12px;height:clamp(330px,56vh,620px);background:#dde8e2;touch-action:none;cursor:grab}
.wb-maps-map:active{cursor:grabbing}
.wb-maps-layer{position:absolute;inset:0}
.wb-maps-map .maps-tile{position:absolute;pointer-events:none;max-width:none}
.wb-maps-map .maps-pin{position:absolute;transform:translate(-50%,-100%);min-height:25px;min-width:25px;padding:0 3px;border-radius:50% 50% 50% 3px;background:#165c51;color:#fff;border:1.5px solid #fff;box-shadow:0 1px 4px #152f2599;font-weight:700;font-size:11px}
.wb-maps-map .maps-pin[aria-pressed=true]{background:#a0402c;z-index:1}
.wb-maps-zoom{position:absolute;top:10px;right:10px;display:grid;gap:3px}
.wb-maps-zoom button{font-size:17px;padding:0;min-width:31px;min-height:29px}
.wb-maps-attribution{position:absolute;right:0;bottom:0;padding:2px 5px;font-size:10px;background:#fffe;color:#182e29}
.wb-maps-attribution a{color:inherit}
.wb-maps-results{overflow:auto;max-height:clamp(330px,56vh,620px);border:1px solid var(--maps-border);border-radius:12px;padding:12px;display:grid;align-content:start;gap:8px}
.wb-maps-results ol{list-style:none;padding:0;margin:0;display:grid;gap:4px}
.wb-maps-results li button{width:100%;display:grid;gap:2px;min-height:0;text-align:left;padding:8px;border-color:transparent}
.wb-maps-results li button[aria-pressed=true]{border-color:#147d6d}
.wb-maps-results li button span{font-weight:600}
.wb-maps-detail{border-top:1px solid var(--maps-border);padding-top:10px;display:grid;gap:5px}
.wb-maps-detail a{color:inherit;width:max-content;font-size:12px}
.wb-maps-categories{display:flex;gap:6px;flex-wrap:wrap}
.wb-maps-categories button{min-height:29px;padding:3px 9px;font-size:12px}
.wb-maps-ask{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}
.wb-maps-empty{min-height:175px;border:1px dashed var(--maps-border);border-radius:12px;display:grid;place-content:center;text-align:center;padding:15px;color:var(--maps-muted);font-size:13px}
 .wb-maps-body{position:relative;display:block}
.wb-maps-map{height:clamp(360px,52vh,560px);border-radius:22px}
.wb-maps-results{position:absolute;z-index:2;left:12px;right:12px;bottom:22px;padding:0;border:0;max-height:none;display:block}
.wb-maps-results ol{display:flex;gap:10px;overflow:auto;scroll-snap-type:x mandatory;padding:3px}
.wb-maps-results li{flex:0 0 clamp(155px,42%,300px);scroll-snap-align:start}
.wb-maps-results li button{min-height:64px;border:1px solid var(--maps-border);border-radius:14px}
.wb-maps-ask{border:1px solid var(--maps-border);border-radius:22px;padding:14px;box-shadow:0 5px 20px #0001}
.wb-maps-ask textarea{background:transparent;color:inherit;border:0;font:inherit;width:100%;min-height:56px;resize:vertical}
.wb-maps-location{border:1px solid var(--maps-border);border-radius:18px;padding:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wb-maps-location p{flex:1;min-width:180px}
.wb-maps-detail{padding:12px;border:1px solid var(--maps-border);border-radius:14px}

@media(max-width:520px){.wb-maps-form,.wb-maps-ask{grid-template-columns:minmax(0,1fr)}.wb-maps-form button,.wb-maps-ask button{justify-self:start}}
`;

    const requestCodec = {
      mode: 'strict',
      typeSymbol: '@dsh-workbench/dsh-maps#SearchRequest',
      jsonSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', minLength: 1, maxLength: 180 }, place: { type: 'string', maxLength: 180 },
          location: { type: 'object', required: ['lat', 'lon'], properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lon: { type: 'number', minimum: -180, maximum: 180 },
          } },
        },
        required: ['area', 'place'],
      },
      create: () => ({
        parse(value) {
          if (typeof value?.area !== 'string' || !value.area.trim() || value.area.length > 180
            || typeof value.place !== 'string' || value.place.length > 180) throw new Error('Enter a valid search.');
          return value;
        },
      }),
    };
    const contribution = {
      package: '@dsh-workbench/dsh-maps',
      descriptors: [{
        id: '@dsh-workbench/dsh-maps#workbenchMaps/search',
        namespace: 'workbenchMaps',
        method: 'search',
        service: 'workbenchMaps',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec, strictCodec: requestCodec }],
        cancellation: { parameter: 'signal' },
        result: { mode: 'strict', typeSymbol: '@dsh-workbench/dsh-maps#SearchResult', jsonSchema: {}, create: () => ({ parse: value => value }) },
      }],
    };

    function MapIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('path', { d: 'M12 21c3.5-4 7-7.2 7-11a7 7 0 1 0-14 0c0 3.8 3.5 7 7 11Z' }),
        h('circle', { cx: 12, cy: 10, r: 2.4 }));
    }

    function project(point, zoom) {
      const world = tileSize * (2 ** zoom);
      const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
      const sine = Math.sin(latitude * Math.PI / 180);
      return {
        x: (point.lon + 180) / 360 * world,
        y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * world,
      };
    }

    function unproject(x, y, zoom) {
      const world = tileSize * (2 ** zoom);
      return {
        lon: ((((x / world) % 1) + 1) % 1) * 360 - 180,
        lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * Math.max(0, Math.min(1, y / world))))) * 180 / Math.PI,
      };
    }

    function ResultMap({ view, setView, places, selected, select, tileURL }) {
      const ref = React.useRef(null);
      const drag = React.useRef(null);
      const layer = React.useRef(null);
      const [size, setSize] = React.useState({ width: 0, height: 0 });
      const [tileError, setTileError] = React.useState(false);
      React.useEffect(() => {
        const element = ref.current;
        const resize = new ResizeObserver(([{ contentRect }]) => {
          setSize({ width: contentRect.width, height: contentRect.height });
        });
        resize.observe(element);
        return () => resize.disconnect();
      }, []);
      React.useEffect(() => setTileError(false), [view.lat, view.lon, view.zoom]);
      const center = project(view, view.zoom);
      const start = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
      const tileCount = 2 ** view.zoom;
      const world = tileCount * tileSize;
      const tiles = [];
      if (size.width && size.height) {
        for (let y = Math.max(0, Math.floor(start.y / tileSize)); y < Math.min(tileCount, Math.ceil((start.y + size.height) / tileSize)); y++) {
          for (let x = Math.floor(start.x / tileSize); x < Math.ceil((start.x + size.width) / tileSize); x++) {
            const wrapped = ((x % tileCount) + tileCount) % tileCount;
            tiles.push(h('img', {
              key: `${view.zoom}/${x}/${y}`,
              src: tileURL.replace('{z}', view.zoom).replace('{x}', wrapped).replace('{y}', y),
              className: 'maps-tile',
              style: { left: x * tileSize - start.x, top: y * tileSize - start.y },
              width: tileSize,
              height: tileSize,
              alt: '',
              draggable: false,
              onError: () => setTileError(true),
            }));
          }
        }
      }

      function zoom(delta) {
        setView({ ...view, zoom: Math.max(minZoom, Math.min(maxZoom, view.zoom + delta)) });
      }
      function pan(x, y) {
        setView({ ...unproject(center.x + x, center.y + y, view.zoom), zoom: view.zoom });
      }
      function keyDown(event) {
        if (event.target !== ref.current) return;
        const direction = { ArrowUp: [0, -75], ArrowDown: [0, 75], ArrowLeft: [-75, 0], ArrowRight: [75, 0] }[event.key];
        if (!direction && !['+', '=', '-'].includes(event.key)) return;
        event.preventDefault();
        if (direction) pan(...direction);
        else zoom(event.key === '-' ? -1 : 1);
      }

      function clearDrag() {
        drag.current = null;
        layer.current?.style.removeProperty('transform');
      }

      const pins = places.map((place, index) => {
        const { x, y } = project(place, view.zoom);
        const wrapped = x + Math.round((center.x - x) / world) * world;
        const left = wrapped - start.x;
        const top = y - start.y;
        if (left < 0 || left > size.width || top < 0 || top > size.height) return null;
        return h('button', {
          key: place.id, type: 'button', className: 'maps-pin', style: { left, top },
          'aria-label': place.name, 'aria-pressed': selected === place.id,
          onClick: () => select(place),
        }, index + 1);
      });
      return h('div', {
        ref, className: 'wb-maps-map', tabIndex: 0, role: 'region', 'aria-label': 'Map. Use arrow keys to pan and plus or minus to zoom.',
        onKeyDown: keyDown,
        onPointerDown(event) {
          if (!event.isPrimary || event.button !== 0 || event.target.closest('button,a')) return;
          drag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerMove(event) {
          if (!drag.current || !layer.current) return;
          const x = event.clientX - drag.current.x;
          const y = event.clientY - drag.current.y;
          layer.current.style.transform = `translate(${x}px,${y}px)`;
        },
        onPointerUp(event) {
          if (!drag.current) return;
          pan(drag.current.x - event.clientX, drag.current.y - event.clientY);
          clearDrag();
        },
        onPointerCancel: clearDrag,
        onLostPointerCapture: clearDrag,
      }, h('div', { ref: layer, className: 'wb-maps-layer' }, ...tiles, ...pins),
      h('div', { className: 'wb-maps-zoom' },
        h('button', { type: 'button', disabled: view.zoom >= maxZoom, 'aria-label': 'Zoom in', onClick: () => zoom(1) }, '+'),
        h('button', { type: 'button', disabled: view.zoom <= minZoom, 'aria-label': 'Zoom out', onClick: () => zoom(-1) }, '−')),
      h('div', { className: 'wb-maps-attribution' },
        tileError && h('span', { role: 'status' }, 'Map tiles unavailable · '),
        h('a', { href: attribution, target: '_blank', rel: 'noreferrer' }, '© OpenStreetMap contributors')));
    }

    function MapsPanel({ search, openChat }) {
      const [area, setArea] = React.useState('');
      const [place, setPlace] = React.useState('');
      const [location, setLocation] = React.useState(null);
      const [locationPrompt, setLocationPrompt] = React.useState(true);
      const [locating, setLocating] = React.useState(false);
      const [shareStatus, setShareStatus] = React.useState('');
      const mounted = React.useRef(false);
      const [question, setQuestion] = React.useState('');
      const [results, setResults] = React.useState(null);
      const [view, setView] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const request = React.useRef(null);
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; request.current?.abort(); };
      }, []);

      function locate(precise) {
        if (!navigator.geolocation) {
          setError('Device location is unavailable. Enter an area instead.');
          return;
        }
        setLocating(true);
        setError('');
        navigator.geolocation.getCurrentPosition(({ coords }) => {
          if (!mounted.current) return;
          setLocating(false);
          const digits = precise ? 5 : 2;
          const point = { lat: Number(coords.latitude.toFixed(digits)), lon: Number(coords.longitude.toFixed(digits)) };
          const label = precise ? 'Current location' : 'Approximate location';
          const category = place.trim() || 'Restaurants';
          setLocation(point);
          setArea(label);
          setPlace(category);
          void submit(category, label, point);
        }, () => {
          if (!mounted.current) return;
          setLocating(false);
          setError('Could not get device location. Enter an area or check location permissions.');
        }, { enableHighAccuracy: precise, timeout: 10000 });
      }

      async function submit(placeQuery, areaQuery = area, point = location) {
        if (request.current || !areaQuery.trim()) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError('');
        try {
          const response = await search({ area: areaQuery.trim(), place: placeQuery.trim(), ...(point ? { location: point } : {}) }, controller.signal);
          if (controller.signal.aborted) return;
          if (!response?.ok) throw new Error('Place search failed.');
          const result = response.value;
          setResults(result);
          setSelected(null);
          setShareStatus('');
          setView(result.area ? { lat: result.area.lat, lon: result.area.lon, zoom: placeQuery.trim() ? 12 : 13 } : null);
        } catch {
          if (!controller.signal.aborted) setError('Place search is unavailable. Try again.');
        } finally {
          if (!controller.signal.aborted) {
            request.current = null;
            setBusy(false);
          }
        }
      }

      function select(result) {
        setSelected(result.id);
        setShareStatus('');
        setView({ lat: result.lat, lon: result.lon, zoom: Math.max(view.zoom, 14) });
      }

      function ask(event) {
        event.preventDefault();
        if (!question.trim()) return;
        const areaDescription = results?.area
          ? [results.area.name, results.area.address].filter(Boolean).join(', ')
          : area.trim();
        const lines = areaDescription ? [`Area: ${areaDescription}`] : [];
        if (activePlace) lines.push(`Selected place: ${[activePlace.name, activePlace.address].filter(Boolean).join(', ')}`);
        if (places.length) lines.push('Nearby map results: ' + places.map(item => [item.name, item.address].filter(Boolean).join(', ')).join(' | '));
        Promise.resolve().then(() => openChat(`${question.trim()}\n\n${lines.join('\n')}`)).catch(() => setError('Could not open a chat. Try again.'));
      }

      const places = results?.places ?? [];
      const activePlace = places.find(result => result.id === selected);
      const placeURL = activePlace && `https://www.openstreetmap.org/?mlat=${activePlace.lat}&mlon=${activePlace.lon}#map=17/${activePlace.lat}/${activePlace.lon}`;
      async function copyPlace() {
        try {
          await navigator.clipboard.writeText(placeURL);
          setShareStatus('Link copied');
        } catch {
          setShareStatus('Could not copy. Open the place to share its URL.');
        }
      }
      return h('section', { className: 'wb-maps', 'aria-label': 'Maps' },
        h('div', { className: 'wb-maps-inner' },
          h('header', null, h('h1', null, 'Maps')),
          h('form', { className: 'wb-maps-ask', onSubmit: ask },
            h('textarea', { 'aria-label': 'Ask DSH what’s nearby', maxLength: 1200, placeholder: 'Ask DSH what’s nearby',
              value: question, onChange: event => setQuestion(event.target.value) }),
            h('button', { type: 'submit', disabled: !question.trim() }, 'Open draft chat')),
          locationPrompt && h('div', { className: 'wb-maps-location' },
            h('p', null, 'Find your current position to see nearby places.'),
            h('button', { type: 'button', disabled: busy || locating, onClick: () => locate(true) }, 'Find my location'),
            h('button', { type: 'button', disabled: busy || locating, onClick: () => locate(false) }, 'Use approximate location'),
            h('button', { type: 'button', onClick: () => setLocationPrompt(false) }, 'Not now')),
          h('form', { className: 'wb-maps-form', onSubmit: event => { event.preventDefault(); void submit(place); } },
            h('label', null, 'Area', h('input', { required: true, maxLength: 180, placeholder: 'City, neighborhood, or address', value: area, onChange: event => { setArea(event.target.value); setLocation(null); } })),
            h('label', null, 'Find nearby', h('input', { maxLength: 180, placeholder: 'A place name or category', value: place, onChange: event => setPlace(event.target.value) })),
            h('button', { type: 'submit', className: 'maps-primary', disabled: busy || locating || !area.trim() }, busy ? 'Searching…' : 'Search')),
          h('div', { className: 'wb-maps-categories', 'aria-label': 'Search categories' },
            ...['Cafés', 'Restaurants', 'Parks', 'Museums'].map(category => h('button', {
              key: category, type: 'button', disabled: busy || locating || !area.trim(),
              onClick: () => { setPlace(category); void submit(category); },
            }, category))),
          error && h('p', { role: 'alert', className: 'maps-muted' }, error),
          view ? h('div', { className: 'wb-maps-body', 'data-single': places.length === 0 },
            h(ResultMap, { view, setView, places, selected, select, tileURL: results.tileURL }),
            places.length > 0 && h('aside', { className: 'wb-maps-results', 'aria-label': 'Nearby results' },
              h('ol', null, ...places.map((result, index) => h('li', { key: result.id },
                h('button', { type: 'button', 'aria-pressed': selected === result.id, onClick: () => select(result) },
                  h('span', null, `${index + 1}. ${result.name}`),
                  result.kind && h('small', { className: 'maps-muted' }, result.kind),
                  result.address && h('small', { className: 'maps-muted' }, result.address)))))))
          : h('div', { className: 'wb-maps-empty', role: 'status' }, results && !error ? 'No matching area. Try a city or neighborhood name.' : 'Choose a location or search for an area.'),

              activePlace && h('div', { className: 'wb-maps-detail' },
                h('h2', null, activePlace.name),
                activePlace.kind && h('p', { className: 'maps-muted' }, activePlace.kind),
                activePlace.address && h('p', { className: 'maps-muted' }, activePlace.address),
                h('a', { href: placeURL, target: '_blank', rel: 'noreferrer' }, 'Open in OpenStreetMap'),
                h('button', { type: 'button', onClick: () => void copyPlace() }, 'Copy place link'),
                shareStatus && h('small', { role: 'status' }, shareStatus)),
          view && results?.searchedNearby && places.length === 0 && h('p', { className: 'maps-muted', role: 'status' }, 'No matching places nearby. Try another name or category.'),
          h('p', { className: 'maps-muted' }, 'Place searches and the location you choose go to Photon. Map tiles come from OpenStreetMap.')));
    }

    return {
      inject: ['slots', 'remote', 'uiWorkspace'],
      async apply(ctx) {
        await ctx.get('remote').$mount(contribution);
        const style = document.createElement('style');
        style.dataset.plugin = '@dsh-workbench/dsh-maps';
        style.textContent = css;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: panelId,
          inject: () => ({
            search: (query, signal) => ctx.get('remote.workbenchMaps').search(query, signal),
            openChat: prompt => ctx.get('uiWorkspace').startSession(undefined, { prompt, whenDraftExists: 'append' }),
          }),
        }, MapsPanel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: panelId, label: 'Maps', order: 40,
        }, MapIcon));
      },
    };
  },
});
