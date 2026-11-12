// Visual projection of project memory (MEMORY-VISUAL-STANDARD, 2026-10-24). Server-side SVG knowledge map,
// source-grounded boards and timeline, full-text cards; the client script only adds interactivity.
import { createHash } from "node:crypto"
import { humanizeFolder } from "./model.mjs"

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const hash = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`
const stamp = (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`
const num = (n) => Math.round(n * 10) / 10

const DESIGN_NOTE = `
MEMORY-VISUAL-STANDARD 2026-10-24. Direction: the first viewport is a graphical project-knowledge map
(labelled topic, folder and run-record nodes, explicit reference edges, folder containment rings) that
owns the majority of the desktop screen; knowledge cards, decision and issue boards and a dated timeline
sit beside it. Raw source reading is secondary and complete: every regular Markdown document and status
record is rendered in full behind the cards. Fact authority: Markdown under .kilocode/memory is the only
truth; this file is a derived projection, rebuilt from source, template and model fingerprints. Edges are
Markdown links, path mentions or folder containment, never inferred. Dates come from dated changelog and
status records; file mtime is labelled as modification only. Archived run records stay marked as history.
Finish condition: source/privacy and vision reviewers accept the rendered screen on real content.
`

const CSS = String.raw`
:root{color-scheme:light dark;--ink:#0b1a2e;--ink-2:#102542;--ink-3:#16304f;--line:#2a4a72;--paper:#f7f9fc;--paper-2:#ffffff;--paper-3:#eaf0f7;--text:#15212f;--muted:#5a6b80;--rule:#d5dde8;--teal:#19c8c0;--teal-2:#0ea5a0;--cyan:#5ad0ff;--amber:#f5b041;--coral:#f0725e;--violet:#a78bfa;--focus:#ffd166;--bar:60px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--r:12px;--shadow:0 10px 30px rgba(11,26,46,.12);--map-bg:radial-gradient(1200px 800px at 40% 40%,#143055 0%,#0b1a2e 55%,#071325 100%)}
@media (prefers-color-scheme:dark){:root{--paper:#0f1a2b;--paper-2:#15233a;--paper-3:#1b2d48;--text:#e6edf6;--muted:#9fb0c6;--rule:#2b4062;--shadow:0 10px 30px rgba(0,0,0,.4)}}
*{box-sizing:border-box}html{font-size:16px;scroll-behavior:smooth}
body{margin:0;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;color:var(--text);background:var(--paper);min-height:100vh}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
button{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:-999px;top:0;background:var(--focus);color:#000;padding:8px 12px;z-index:50}.skip:focus{left:8px}
header.bar{position:sticky;top:0;z-index:20;height:var(--bar);display:flex;align-items:center;gap:var(--s4);padding:0 var(--s5);background:var(--ink);color:#e9f1ff;border-bottom:1px solid var(--line)}
.brand{display:flex;flex-direction:column;min-width:0}.brand b{font-size:17px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.brand small{color:#9cc3ea;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .status{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:var(--ink-3);font-size:13.5px;white-space:nowrap;min-height:34px}
.bar .status i{width:10px;height:10px;border-radius:50%;background:#8a9bb5;display:inline-block}
body[data-status=live] .bar .status i{background:var(--teal);box-shadow:0 0 0 4px rgba(25,200,192,.25)}
body[data-status=disconnected] .bar .status i{background:var(--coral)}body[data-status=unavailable] .bar .status i{background:var(--amber)}
.search{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.search input{flex:1;min-width:0;height:44px;border-radius:10px;border:1px solid var(--line);background:var(--ink-2);color:#fff;padding:0 14px;font-size:15px}
.search input::placeholder{color:#8fa6c4}
.bar .btn{height:44px;min-width:44px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:var(--ink-2);color:#e9f1ff;cursor:pointer}
.bar .btn[aria-pressed=true]{background:var(--teal-2);border-color:var(--teal-2);color:#04121a}
main{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);height:calc(100vh - var(--bar));min-height:560px}
#map,#panel{min-width:0}
.sw{display:inline-block;width:12px;height:12px;border-radius:50%;flex:none;border:2px solid rgba(255,255,255,.6)}.sw.hub{background:#ffd166}.sw.doc{background:#0ea5a0}.sw.topic{background:#2b8fd1}.sw.archive{background:#e0932a}
.link{background:none;border:0;padding:0;color:var(--teal-2);font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px;min-height:32px}
.btn.txt{font-size:14px}
.tl details.sec{margin-top:8px}
.card,.pane{overflow-wrap:anywhere}.pane pre{overflow:auto}
#list .sub{padding-left:28px;margin-top:6px}
#map{position:relative;background:var(--map-bg);overflow:hidden;min-height:50vh;outline:none;touch-action:none}
#map svg{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab}#map.dragging svg{cursor:grabbing}
.sector{fill:rgba(255,255,255,.035);stroke:rgba(255,255,255,.06)}.sector.current{fill:rgba(25,200,192,.07)}.sector.topic{fill:rgba(90,208,255,.06)}.sector.archive{fill:rgba(245,176,65,.06)}
.sector-label{fill:#9cc3ea;font-size:24px;letter-spacing:1.6px;text-transform:uppercase;font-weight:600}
.edge{fill:none;stroke:#7fb3e6;stroke-opacity:.42;stroke-width:1.4;transition:stroke-opacity .25s,stroke-width .25s}
.edge.w2{stroke-width:2.2}.edge.w3{stroke-width:3.2}
.edge-label{fill:#dfeeff;font-size:20px;paint-order:stroke;stroke:#0b1a2e;stroke-width:6px;stroke-linejoin:round;opacity:0;pointer-events:none;transition:opacity .25s}
#map.focused .edge{stroke-opacity:.08}#map.focused .edge.lit{stroke:var(--focus);stroke-opacity:.95}#map.focused .edge.lit+.edge-label,.edge-label.lit{opacity:1}
.node{cursor:pointer;outline:none}.node .hit{fill:transparent}
.node .body{stroke-width:2.5;transition:transform .25s,filter .25s}
.node.doc .body{fill:#0ea5a0;stroke:#9ff5ef}.node.hub .body{fill:#ffd166;stroke:#fff3d0}.node.folder.topic .body{fill:#2b8fd1;stroke:#9fdcff}.node.folder.archive .body{fill:#e0932a;stroke:#ffd9a0}
.node .ring{fill:rgba(255,255,255,.03);stroke:rgba(255,255,255,.22);stroke-dasharray:3 4}.node.archive .ring{stroke:rgba(245,176,65,.45)}.node.topic .ring{stroke:rgba(90,208,255,.45)}
.node text,.sat text{pointer-events:none}
.node .label{fill:#f4f8ff;font-size:30px;font-weight:600;paint-order:stroke;stroke:#0b1a2e;stroke-width:8px;stroke-linejoin:round}
.node .meta{fill:#a9c5e6;font-size:19px;paint-order:stroke;stroke:#0b1a2e;stroke-width:6px}
.node.hub .label{font-size:34px}
.node .sats,.node .ring{display:none}.node.open .sats,.node.open .ring{display:initial}
.sat{cursor:pointer;outline:none}.sat circle{fill:#cfe6ff;stroke:#0b1a2e;stroke-width:1.5}.sat.has-facts circle{fill:#9ff5ef}.sat.status circle{fill:#ffd9a0}
.sat text{fill:#e6f0ff;font-size:18px;paint-order:stroke;stroke:#0b1a2e;stroke-width:5px;opacity:0;transition:opacity .2s;pointer-events:none}
.node.open .sat text,.sat:focus-visible text,.sat:hover text{opacity:1}
.node.selected .body,.sat.selected circle{stroke:var(--focus);stroke-width:4}
.node:focus-visible .body{stroke:var(--focus);stroke-width:4}
#map.focused .node{opacity:.35}#map.focused .node.selected,#map.focused .node.neighbor,#map.focused .node.hub.neighbor{opacity:1}
.spoke{stroke:rgba(255,255,255,.18);stroke-width:1}
.map-ui{position:absolute;display:flex;gap:6px;z-index:3;pointer-events:none}.map-ui>*{pointer-events:auto}
.map-ui.pos-tl{left:var(--s4);top:var(--s4);flex-direction:column;align-items:flex-start}.map-ui.pos-tr{right:var(--s4);top:var(--s4)}.map-ui.pos-br{right:var(--s4);bottom:var(--s4);flex-direction:column;align-items:flex-end}
.map-ui .btn{height:44px;min-width:44px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(11,26,46,.78);color:#e9f1ff;cursor:pointer;backdrop-filter:blur(6px);font-size:18px;padding:0 12px}
.map-ui .btn[aria-pressed=true]{background:var(--teal-2);color:#04121a}
.legend{background:rgba(11,26,46,.78);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;color:#e9f1ff;font-size:12.5px;line-height:1.5;backdrop-filter:blur(6px)}
.legend h2{margin:0 0 4px;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#9cc3ea}
.legend li{display:flex;align-items:center;gap:8px;list-style:none}.legend ul{margin:0;padding:0}

.legend .ln{width:22px;height:0;border-top:2px solid #7fb3e6;display:inline-block}.legend .ln.dash{border-top:2px dashed rgba(255,255,255,.5)}
.minimap{width:180px;height:120px;background:rgba(11,26,46,.85);border:1px solid rgba(255,255,255,.18);border-radius:10px;overflow:hidden}
.minimap svg{width:100%;height:100%;display:block}.minimap .vp{fill:rgba(255,209,102,.15);stroke:var(--focus);stroke-width:4}
.minimap circle{fill:#9cc3ea}
#list{position:absolute;inset:0;z-index:2;background:rgba(7,19,37,.92);color:#e9f1ff;overflow:auto;padding:var(--s5);display:none;backdrop-filter:blur(4px)}
#map[data-list=on] #list{display:block}#map[data-list=on] svg,#map[data-list=on] .map-ui.pos-br,#map[data-list=on] .map-ui.pos-tl{display:none}
#list h2{font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:#9cc3ea;margin:var(--s4) 0 var(--s2)}
#list ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
#list button,#list summary{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;text-align:left;padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:inherit;cursor:pointer}
#list button[aria-pressed=true]{border-color:var(--focus);background:rgba(255,209,102,.12)}
#list small{color:#9cc3ea;margin-left:auto;white-space:nowrap}
#list summary::before,.tree summary::before{content:"+";width:12px;flex:none}#list details[open]>summary::before,.tree details[open]>summary::before{content:"−"}
.toast{position:absolute;left:50%;bottom:var(--s4);transform:translate(-50%,0);background:var(--teal);color:#04121a;padding:10px 16px;border-radius:999px;font-weight:600;font-size:14px;z-index:4;opacity:0;transition:opacity .3s}.toast.show{opacity:1}
#panel{display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--rule);background:var(--paper)}
.tabs{display:flex;gap:4px;padding:var(--s3) var(--s4) 0;border-bottom:1px solid var(--rule);overflow-x:auto;flex:none;background:var(--paper)}
.tabs button{min-height:44px;padding:0 14px;border:0;border-bottom:3px solid transparent;background:none;cursor:pointer;color:var(--muted);font-weight:600;white-space:nowrap;border-radius:8px 8px 0 0}
.tabs button[aria-selected=true]{color:var(--text);border-bottom-color:var(--teal-2)}
.tabs button b{display:inline-block;min-width:22px;padding:0 6px;border-radius:999px;background:var(--paper-3);color:var(--muted);font-size:12px;margin-left:6px;text-align:center}
.pane{display:none;overflow:auto;padding:var(--s4) var(--s5) var(--s6);min-height:0}.pane[data-active]{display:block}
.pane>h2,.pane>.lead{max-width:68ch}
.card{background:var(--paper-2);border:1px solid var(--rule);border-radius:var(--r);padding:var(--s4) var(--s5);margin:0 0 var(--s3);box-shadow:var(--shadow);max-width:min(72ch,100%)}
.card h3{margin:0 0 6px;font-size:16px;line-height:1.35}.card p{margin:0 0 var(--s2)}
.card .field{display:grid;grid-template-columns:7.5em 1fr;gap:6px 12px;margin-top:8px;font-size:15px}.card .field b{color:var(--teal-2);font-size:12px;letter-spacing:1.2px;text-transform:uppercase;padding-top:3px}
.card .field.why b{color:#1f8fcf}.card .field.how b{color:#c87a1a}
.cite{display:inline-flex;align-items:center;gap:6px;max-width:100%;overflow-wrap:anywhere;margin-top:10px;min-height:32px;padding:4px 10px;border-radius:8px;border:1px solid var(--rule);background:var(--paper-3);color:var(--muted);font-size:13px;cursor:pointer;text-align:left}
.cite:hover{color:var(--text)}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.3px;vertical-align:middle}
.chip.rule{background:#dff8f6;color:#0b6b67}.chip.decision{background:#e3f1ff;color:#13578a}.chip.issue{background:#ffe6e1;color:#9b3524}.chip.archive{background:#fff0d6;color:#8a5a0f}.chip.current{background:#dff8f6;color:#0b6b67}.chip.changelog{background:#e3f1ff;color:#13578a}.chip.status{background:#fff0d6;color:#8a5a0f}
@media (prefers-color-scheme:dark){.chip.rule,.chip.current{background:#0f3d3a;color:#9ff5ef}.chip.decision,.chip.changelog{background:#143a5a;color:#9fdcff}.chip.issue{background:#4a1e16;color:#ffb3a3}.chip.archive,.chip.status{background:#4a3410;color:#ffd9a0}}
.node-head{display:flex;flex-direction:column;gap:6px;margin-bottom:var(--s4);max-width:72ch}.node-head h2{margin:0;font-size:22px;line-height:1.25}
.node-head .path{color:var(--muted);font-size:13px;word-break:break-all}
.kv{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--muted);font-size:13.5px}
.related{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-width:min(72ch,100%)}
.related li{background:var(--paper-2);border:1px solid var(--rule);border-radius:10px;padding:10px 14px}

.related .ex{color:var(--muted);font-size:14px;margin:4px 0 0}
details.sec{border:1px solid var(--rule);border-radius:10px;background:var(--paper-2);margin:0 0 8px;max-width:min(76ch,100%)}
details.sec>summary{cursor:pointer;padding:10px 14px;min-height:44px;display:flex;align-items:center;gap:10px;font-weight:600}
details.sec>summary small{color:var(--muted);font-weight:400;margin-left:auto;white-space:nowrap}
details.sec>div{padding:4px 18px 14px;max-width:72ch}
#cards .folder-area{border:1px solid var(--rule);border-radius:10px;background:var(--paper-2);margin:0 0 8px;max-width:min(76ch,100%)}
#cards .folder-area>summary{cursor:pointer;padding:10px 14px;min-height:44px;display:flex;align-items:center;gap:10px;font-weight:600}
#cards .folder-area>summary small{color:var(--muted);font-weight:400;margin-left:auto;white-space:nowrap}
#cards .folder-area>.related{margin:4px 14px 14px}
details.sec h1,details.sec h2,details.sec h3,details.sec h4{line-height:1.3}
.sec pre{overflow:auto;padding:12px;background:var(--paper-3);border-radius:8px;font-size:13.5px;max-width:100%}
.table-wrap{overflow:auto;max-width:100%;margin:8px 0}.table-wrap table{border-collapse:collapse;font-size:14px}.table-wrap th,.table-wrap td{border:1px solid var(--rule);padding:6px 8px;text-align:left;vertical-align:top}
.dead-link{color:var(--muted);text-decoration:line-through dotted}
.image-link{color:var(--muted);font-style:italic}
h2.board{font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin:var(--s4) 0 var(--s3)}
.day{position:sticky;top:0;background:var(--paper);padding:6px 0;font-weight:700;font-size:14px;color:var(--muted);z-index:1;border-bottom:1px solid var(--rule);margin:var(--s3) 0 var(--s2)}
.tl{position:relative;list-style:none;margin:0;padding:0 0 0 22px;border-left:2px solid var(--rule);max-width:min(72ch,100%)}
.tl li{position:relative;margin:0 0 12px;padding:10px 14px;background:var(--paper-2);border:1px solid var(--rule);border-radius:10px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;min-width:0}
.tl .sum,.tl .fields-wrap,.tl .foot{flex:1 1 100%;min-width:0;overflow-wrap:anywhere}.tl .cite{white-space:normal;text-align:left}
.tl li::before{content:"";position:absolute;left:-29px;top:16px;width:12px;height:12px;border-radius:50%;background:var(--cyan);border:2px solid var(--paper)}
.tl li.status::before{background:var(--amber)}.tl .when{font-weight:700;margin-right:8px}
.tl .fields{margin:8px 0 0;display:grid;grid-template-columns:5.5em 1fr;gap:4px 10px;font-size:14px}.tl .fields b{color:var(--muted);font-size:12px;letter-spacing:1px;text-transform:uppercase;padding-top:3px}
.tree{list-style:none;margin:0;padding:0}.tree li{margin:0}.tree button,.tree summary{display:flex;gap:8px;align-items:center;width:100%;min-height:44px;text-align:left;padding:6px 10px;border:0;background:none;border-radius:8px;cursor:pointer}
.tree button:hover,.tree summary:hover{background:var(--paper-3)}.tree button small,.tree summary small{color:var(--muted);margin-left:auto;white-space:nowrap}.tree .grp{font-size:13px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);margin:var(--s4) 0 6px}
.tree .sub{padding-left:16px;border-left:2px solid var(--rule);margin-left:12px}
.census{font-size:14px;color:var(--muted)}.census dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:8px 0}.census dt{font-weight:600}
mark{background:var(--focus);color:#000;padding:0 2px;border-radius:3px}
#results{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-width:72ch}
#results li button{width:100%;text-align:left;background:var(--paper-2);border:1px solid var(--rule);border-radius:10px;padding:10px 14px;cursor:pointer;min-height:44px}
#results .crumb{color:var(--muted);font-size:13px;display:block;margin-bottom:4px}
.empty{color:var(--muted);font-style:italic}
.needs{color:var(--muted);font-style:italic}.plain-sec h3{margin:0 0 6px;font-size:16px;line-height:1.3}.plain-sec p{margin:0}.tech dl{display:grid;grid-template-columns:9em 1fr;gap:4px 12px;font-size:14px}.tech dd{margin:0;overflow-wrap:anywhere}#results li>details.sec{margin:6px 0 0}
.notice{border:1px solid var(--amber);background:rgba(245,176,65,.12);border-radius:10px;padding:10px 14px;margin:0 0 var(--s3);font-size:14.5px}
body:not([data-status=live]) .live-only{display:none}
#pick{display:none}
@media (max-width:1000px){main{grid-template-columns:1fr;height:auto;min-height:0}#map{height:min(46vh,400px);min-height:220px}#pick{display:block;padding:var(--s3) var(--s4);border-top:1px solid var(--rule);background:var(--paper-2)}#pick h2{font-size:16px;margin:0 0 8px}#pick ul{list-style:none;margin:0;padding:0;display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))}#pick button{display:block;width:100%;min-height:44px;font:inherit;font-size:16px;line-height:1.3;text-align:left;padding:10px 12px;border-radius:10px;border:1px solid var(--rule);background:var(--paper);color:var(--text);white-space:normal;overflow-wrap:anywhere;cursor:pointer}#pick button[aria-pressed=true]{border-color:var(--focus);box-shadow:inset 0 0 0 2px var(--focus)}#pick small{display:block;font-size:14px;color:var(--muted)}#panel{border-left:0;border-top:1px solid var(--rule)}.pane{max-height:none}header.bar{height:auto;min-height:var(--bar);flex-wrap:wrap;padding:8px var(--s4);gap:8px}.brand{flex:1 1 60%}.search{flex:1 1 100%;order:3}.minimap{display:none}.legend{font-size:12px;max-width:170px}}
@media (max-width:1000px) and (max-height:560px){#map{height:170px;min-height:170px}.legend{display:none}header.bar{flex-wrap:wrap;padding:4px var(--s4);gap:6px}.brand{flex:1 1 0}.brand small{display:none}.bar .status{min-height:30px;padding:4px 10px}}
@media (max-width:480px){.legend{display:none}.bar .status{white-space:normal;max-width:100%;line-height:1.3}.card{padding:var(--s3) var(--s4)}.card .field{grid-template-columns:1fr}.pane{padding:var(--s3) var(--s4)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`

const SCRIPT = String.raw`
(() => {
  "use strict";
  const d = document, $ = (s, r) => (r || d).querySelector(s), $$ = (s, r) => Array.from((r || d).querySelectorAll(s));
  const map = $("#map"), svg = $("#map-svg"), world = $("#world"), body = d.body;
  const base = svg.viewBox.baseVal;
  let model = JSON.parse($("#model").textContent);
  const st = { k: 1, x: 0, y: 0, node: null, doc: null, tab: "knowledge", query: "", list: false, version: Number(body.dataset.version) };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fold = (s) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // ---- map transform
  const apply = () => { world.setAttribute("transform", "translate(" + st.x + " " + st.y + ") scale(" + st.k + ")"); // 2026-10-24: gate satellite labels on rendered scale, not camera k, so narrow hub focus stays uncluttered.
    const r = svg.getBoundingClientRect(); map.dataset.zoom = st.k * Math.min(r.width / base.width, r.height / base.height) >= 0.55 ? "in" : "out"; drawMini(); };
  const clientToWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); const sx = base.width / r.width, sy = base.height / r.height, s = Math.max(sx, sy); const ox = (base.width - r.width * s) / 2, oy = (base.height - r.height * s) / 2; return { x: base.x + ox + (cx - r.left) * s, y: base.y + oy + (cy - r.top) * s }; };
  const zoomAt = (factor, cx, cy) => { const p = clientToWorld(cx, cy); const k = Math.min(8, Math.max(0.35, st.k * factor)); st.x = p.x - (p.x - st.x) * (k / st.k); st.y = p.y - (p.y - st.y) * (k / st.k); st.k = k; apply(); };
  const center = () => { const r = svg.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const fit = () => { st.k = 1; st.x = 0; st.y = 0; apply(); };
  const focusOn = (el, k) => { if (!el) return; const b = el.getBBox(), m = el.getCTM(), w = world.getCTM(); const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2; const q = p.matrixTransform(w.inverse().multiply(m)); const target = k || Math.max(st.k, 1.8); st.k = target; st.x = base.x + base.width / 2 - q.x * target; st.y = base.y + base.height / 2 - q.y * target; apply(); };
  let drag = null;
  // Pointer capture only once a real drag starts; capturing on pointerdown would retarget the click to the svg.
  svg.addEventListener("pointerdown", (e) => { if (e.button !== 0 && e.pointerType === "mouse") return; drag = drag || { pts: new Map(), moved: false, x: st.x, y: st.y, k: st.k }; drag.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }); });
  svg.addEventListener("pointermove", (e) => { if (!drag || !drag.pts.has(e.pointerId)) return; const pt = drag.pts.get(e.pointerId); const r = svg.getBoundingClientRect(); const s = Math.max(base.width / r.width, base.height / r.height); if (drag.pts.size === 1) { const dx = e.clientX - pt.x, dy = e.clientY - pt.y; if (!drag.moved && Math.abs(e.clientX - pt.sx) + Math.abs(e.clientY - pt.sy) > 4) { drag.moved = true; map.classList.add("dragging"); for (const id of drag.pts.keys()) svg.setPointerCapture(id); } st.x += dx * s; st.y += dy * s; pt.x = e.clientX; pt.y = e.clientY; apply(); } else { const [a, b] = [...drag.pts.values()]; const before = Math.hypot(a.x - b.x, a.y - b.y); pt.x = e.clientX; pt.y = e.clientY; const after = Math.hypot(a.x - b.x, a.y - b.y); if (before > 0) zoomAt(after / before, (a.x + b.x) / 2, (a.y + b.y) / 2); drag.moved = true; } });
  const endDrag = (e) => { if (!drag) return; drag.pts.delete(e.pointerId); if (!drag.pts.size) { const moved = drag.moved; drag = null; map.classList.remove("dragging"); if (moved) svg.addEventListener("click", (ev) => ev.stopPropagation(), { capture: true, once: true }); } };
  svg.addEventListener("pointerup", endDrag); svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  $("#zoom-in").addEventListener("click", () => { const c = center(); zoomAt(1.4, c.x, c.y); });
  $("#zoom-out").addEventListener("click", () => { const c = center(); zoomAt(1 / 1.4, c.x, c.y); });
  $("#zoom-fit").addEventListener("click", fit);
  $("#zoom-focus").addEventListener("click", () => focusOn(currentEl(), 2.2));
  map.addEventListener("keydown", (e) => { if (e.target !== map && e.target !== svg) return; const step = 60 / st.k; const k = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key]; if (k) { st.x += k[0] * st.k; st.y += k[1] * st.k; apply(); e.preventDefault(); } else if (e.key === "+" || e.key === "=") { const c = center(); zoomAt(1.3, c.x, c.y); } else if (e.key === "-") { const c = center(); zoomAt(1 / 1.3, c.x, c.y); } else if (e.key === "0") fit(); });
  const currentEl = () => st.doc && $('[data-doc="' + st.doc + '"]', svg) || st.node && $('[data-node="' + st.node + '"]', svg);

  // ---- minimap
  const mini = $("#minimap svg");
  function drawMini() { if (!mini) return; const vp = $(".vp", mini); const r = svg.getBoundingClientRect(); const s = Math.max(base.width / r.width, base.height / r.height); const w = r.width * s / st.k, h = r.height * s / st.k; const ox = (base.width - r.width * s) / 2, oy = (base.height - r.height * s) / 2; vp.setAttribute("x", (base.x + ox - st.x) / st.k); vp.setAttribute("y", (base.y + oy - st.y) / st.k); vp.setAttribute("width", w); vp.setAttribute("height", h); }
  mini && mini.addEventListener("click", (e) => { const r = mini.getBoundingClientRect(); const vb = mini.viewBox.baseVal; const s = Math.max(vb.width / r.width, vb.height / r.height); const ox = (vb.width - r.width * s) / 2, oy = (vb.height - r.height * s) / 2; const px = vb.x + ox + (e.clientX - r.left) * s, py = vb.y + oy + (e.clientY - r.top) * s; st.x = base.x + base.width / 2 - px * st.k; st.y = base.y + base.height / 2 - py * st.k; apply(); });

  // ---- selection
  function highlight() {
    $$(".node.selected, .node.neighbor, .sat.selected, .node.open", svg).forEach((n) => n.classList.remove("selected", "neighbor", "open"));
    $$(".edge.lit, .edge-label.lit", svg).forEach((n) => n.classList.remove("lit"));
    map.classList.toggle("focused", Boolean(st.node));
    if (!st.node) return;
    const node = $('[data-node="' + st.node + '"]', svg); if (node) { node.classList.add("selected", "open"); }
    if (st.doc) { const sat = $('[data-doc="' + st.doc + '"]', svg); if (sat) sat.classList.add("selected"); }
    model.edges.forEach((e) => { if (e.a !== st.node && e.b !== st.node) return; const other = e.a === st.node ? e.b : e.a; const el = $('[data-edge="' + e.id + '"]', svg); if (el) { el.classList.add("lit"); const lab = $('[data-edge-label="' + e.id + '"]', svg); lab && lab.classList.add("lit"); } const n = $('[data-node="' + other + '"]', svg); n && n.classList.add("neighbor"); });
    $$("#list button[data-node], #pick button[data-node]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.node === st.node && !st.doc)));
  }
  function showCard() {
    const pane = $("#knowledge"); const id = st.doc || st.node;
    $$(".card-root", pane).forEach((c) => { c.hidden = c.dataset.card !== id; });
    const shown = $('.card-root[data-card="' + id + '"]', pane); $("#overview").hidden = Boolean(shown);
    if (shown && st.section) { const sec = $('[data-section="' + st.section + '"]', shown); if (sec) { sec.open = true; sec.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" }); } }
    else pane.scrollTop = 0;
  }
  function select(nodeId, docId, section, opts) {
    opts = opts || {}; st.node = nodeId || null; st.doc = docId && docId !== nodeId ? docId : null; st.section = section || null;
    highlight(); setTab("knowledge"); showCard();
    if (!opts.keepView && st.node) { const el = currentEl(); if (el && !opts.noPan) focusOn(el, Math.max(st.k, st.doc ? 2.6 : 1.6)); }
    if (st.node) history.replaceState(null, "", "#" + (st.section || st.doc || st.node)); else history.replaceState(null, "", location.pathname + location.search);
  }
  const nodeOfDoc = (docId) => { const n = model.docs[docId]; return n ? n.n : null; };
  d.addEventListener("click", (e) => {
    const pick = e.target.closest("#pick button[data-node]"); if (pick) { select(pick.dataset.node); return; }
    const sat = e.target.closest(".sat"); if (sat) { e.stopPropagation(); select(sat.dataset.node, sat.dataset.doc); return; }
    const node = e.target.closest(".node"); if (node) { e.stopPropagation(); select(node.dataset.node); return; }
    const open = e.target.closest("[data-open-doc]"); if (open) { e.preventDefault(); const doc = open.dataset.openDoc; select(nodeOfDoc(doc) || doc, doc, open.dataset.openSection); return; }
    const openNode = e.target.closest("[data-open-node]"); if (openNode) { e.preventDefault(); select(openNode.dataset.openNode); return; }
    const tabLink = e.target.closest("[data-tab-link]"); if (tabLink) { e.preventDefault(); setTab(tabLink.dataset.tabLink); return; }
    const link = e.target.closest("a[data-doc]"); if (link) { e.preventDefault(); const doc = link.dataset.doc; select(nodeOfDoc(doc) || doc, doc, link.getAttribute("href").slice(1) !== doc ? link.getAttribute("href").slice(1) : null); return; }
    if (e.target === svg || e.target.closest(".sector")) { if (st.node) select(null); }
  });
  d.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; const t = e.target.closest(".node, .sat"); if (!t) return; e.preventDefault(); t.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  // Arrow keys move between map nodes when one is focused.
  svg.addEventListener("keydown", (e) => { const t = e.target.closest(".node"); if (!t || !/^Arrow/.test(e.key)) return; const nodes = $$(".node", svg); const i = nodes.indexOf(t); const next = nodes[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : nodes.length - 1)) % nodes.length]; next.focus(); e.preventDefault(); });

  // ---- tabs and list toggle
  function setTab(name) { st.tab = name; $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name))); $$(".pane").forEach((p) => { if (p.id === name) p.setAttribute("data-active", ""); else p.removeAttribute("data-active"); }); }
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  const listBtn = $("#list-toggle");
  listBtn.addEventListener("click", () => { st.list = !st.list; map.dataset.list = st.list ? "on" : "off"; listBtn.setAttribute("aria-pressed", String(st.list)); if (st.list) { const first = $("#list button"); first && first.focus(); } });
  $("#list").addEventListener("click", (e) => { const b = e.target.closest("button[data-node]"); if (!b) return; select(b.dataset.node, b.dataset.doc, null, { keepView: true }); });

  // ---- search
  const input = $("#q"), results = $("#results"), summary = $("#search-summary");
  const excerpt = (text, i, len) => { const start = Math.max(0, i - 90), end = Math.min(text.length, i + len + 150); const frag = d.createDocumentFragment(); const part = text.slice(start, end).replace(/\s+/g, " "); const j = fold(part).indexOf(fold(st.query)); if (start > 0) frag.append("… "); if (j === -1) frag.append(part); else { frag.append(part.slice(0, j)); const m = d.createElement("mark"); m.textContent = part.slice(j, j + len); frag.append(m, part.slice(j + len)); } if (end < text.length) frag.append(" …"); return frag; };
  function search(silent) {
    const q = input.value.trim(); st.query = q; results.replaceChildren();
    if (q.length < 2) { summary.textContent = "Type at least two characters to search every fact, section and record."; if (st.tab === "search") setTab("knowledge"); return; }
    const needle = fold(q); let hits = 0; const perDoc = {};
    for (const s of model.sections) { const raw = s.h + "\n" + s.t; const i = fold(raw).indexOf(needle); const pi = model.plain ? fold(s.p || "").indexOf(needle) : -1; if (i === -1 && pi === -1) continue; perDoc[s.d] = (perDoc[s.d] || 0) + 1; if (hits++ >= 80) continue; const li = d.createElement("li"), b = d.createElement("button"); b.type = "button"; b.dataset.openDoc = s.d; b.dataset.openSection = s.id; const crumb = d.createElement("span"); crumb.className = "crumb"; li.append(b);
      if (!model.plain) { crumb.textContent = (model.nodes[s.n] ? model.nodes[s.n] + " › " : "") + s.r + (s.h ? " § " + s.h : "") + (s.a ? " · archived record" : ""); b.append(crumb, excerpt(raw, i, q.length)); }
      else {
        crumb.textContent = (model.nodes[s.n] ? model.nodes[s.n] + " › " : "") + (model.docs[s.d] ? model.docs[s.d].t : "") + (s.pt ? " § " + s.pt : "") + (s.a ? " · past run record" : "");
        const say = d.createElement("span"); say.className = "say";
        if (pi !== -1) say.append(excerpt(s.p, pi, q.length)); else if (s.p) say.textContent = s.p.length > 240 ? s.p.slice(0, 240) + " …" : s.p; else { say.className = "say needs"; say.textContent = "Plain-language explanation needs updating."; }
        b.append(crumb, say);
        if (i !== -1) { const det = d.createElement("details"), sum = d.createElement("summary"), div = d.createElement("div"), src = d.createElement("p"); det.className = "sec"; sum.textContent = "Matching original text"; src.className = "mono"; src.textContent = s.r + (s.h ? " § " + s.h : ""); div.append(src, excerpt(raw, i, q.length)); det.append(sum, div); li.append(det); }
      }
      results.append(li); }
    summary.textContent = hits ? hits + " matching section" + (hits === 1 ? "" : "s") + " in " + Object.keys(perDoc).length + " document" + (Object.keys(perDoc).length === 1 ? "" : "s") + (hits > 80 ? " (first 80 shown)" : "") + "." : "No section contains “" + q + "”.";
    if (!silent) setTab("search");
    // Focus the map on the best-covered topic so the hit is visible in context.
    const top = Object.entries(perDoc).sort((a, b) => b[1] - a[1])[0]; if (top) { const n = nodeOfDoc(top[0]) || top[0]; st.node = n; st.doc = n !== top[0] ? top[0] : null; highlight(); const el = currentEl(); if (el) focusOn(el, Math.max(st.k, 1.6)); }
  }
  let timer; input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 120); });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; search(); select(null); } if (e.key === "Enter") { const first = $("#results button"); first && first.click(); } });
  d.addEventListener("keydown", (e) => { if (e.key === "/" && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); input.focus(); } });

  // ---- status badge
  const badge = $("#status"), badgeText = $("#status-text");
  function setStatus(status, text) { body.dataset.status = status; badgeText.textContent = text; badge.setAttribute("aria-label", "Data state: " + text); }
  const initialStatus = body.dataset.status, built = body.dataset.built;
  const fmt = (iso) => iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "";
  if (body.dataset.mode === "snapshot") setStatus("snapshot", "Snapshot · built " + fmt(built) + " · not updating");

  // ---- live update: swap regions, keep selection, search, view and reading position
  async function refresh(event) {
    let next; try { const r = await fetch("view", { cache: "no-store", credentials: "same-origin" }); if (!r.ok) throw new Error(r.status); next = new DOMParser().parseFromString(await r.text(), "text/html"); } catch { setStatus("disconnected", "Disconnected · showing data from " + fmt(body.dataset.built)); return; }
    const pane = $(".pane[data-active]"), scroll = pane ? pane.scrollTop : 0, active = d.activeElement && d.activeElement.id;
    for (const id of ["world", "overview", "cards", "decisions", "issues", "timeline", "sources", "list", "pick", "model", "minimap", "map-title", "brand-sub"]) { const a = $("#" + id), b = $("#" + id, next); if (a && b) a.replaceWith(d.importNode(b, true)); }
    model = JSON.parse($("#model").textContent);
    $$(".tabs button b, .tabs button span").forEach((el) => { const n = $('.tabs button[data-tab="' + el.parentNode.dataset.tab + '"] ' + el.tagName.toLowerCase(), next); if (n) el.textContent = n.textContent; });
    body.dataset.version = next.body.dataset.version; body.dataset.built = next.body.dataset.built; st.version = Number(next.body.dataset.version);
    const tab = st.tab; apply(); highlight(); if (st.node) showCard(); if (st.query.length >= 2) search(true); setTab(tab);
    const p2 = $(".pane[data-active]"); if (p2) p2.scrollTop = scroll; if (active) { const el = d.getElementById(active); el && el.focus({ preventScroll: true }); }
    const c = event && event.changed; toast(c ? "Memory updated · " + [c.added && c.added + " added", c.modified && c.modified + " modified", c.removed && c.removed + " removed"].filter(Boolean).join(", ") : "Memory updated");
  }
  const toastEl = $("#toast"); let toastTimer;
  function toast(text) { toastEl.textContent = text; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200); }
  if (body.dataset.mode === "live") {
    setStatus(initialStatus === "live" ? "live" : initialStatus, initialStatus === "live" ? "Live · data as of " + fmt(built) : initialStatus === "unavailable" ? "Source unavailable · showing last good build " + fmt(built) : initialStatus);
    const source = new EventSource("events");
    source.addEventListener("state", async (e) => { const s = JSON.parse(e.data); if (s.status === "unavailable") setStatus("unavailable", "Source unavailable (" + (s.error || "read failed") + ") · showing last good build " + fmt(body.dataset.built)); else setStatus("live", "Live · data as of " + fmt(s.builtAt)); if (s.version > st.version) await refresh(s); });
    source.addEventListener("error", () => setStatus("disconnected", "Disconnected · showing data from " + fmt(body.dataset.built) + " · reconnecting"));
  }

  // ---- initial state from URL hash
  const h = location.hash.slice(1);
  if (h) { const docId = h.split("-h")[0]; if (model.docs[docId]) select(nodeOfDoc(docId) || docId, docId, h !== docId ? h : null); else if (model.nodes[h]) select(h); }
  // Small or zoomed viewports start focused on the hub at a zoom that keeps topic labels at about 13 px.
  // Desktop shows the whole map at fit (labels sized for that); narrow or 200 % viewports start on the hub instead.
  if (!h) { const r = svg.getBoundingClientRect(); const s = Math.min(r.width / base.width, r.height / base.height); const k = Math.min(4, Math.max(1, 13 / (30 * s))); if (k > 1.05 && r.width < 1000) focusOn($(".node.hub", svg) || $(".node", svg), k); }
  apply();
  addEventListener("resize", drawMini);
})();
`

const SCRIPT_HASH = hash(SCRIPT)
const STYLE_HASH = hash(CSS)
const CSP = `default-src 'none'; script-src ${SCRIPT_HASH}; style-src ${STYLE_HASH}; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

/** Layout and the rest of the renderer are fingerprinted as well: any change republishes memory.html. */
export const TEMPLATE_HASH = createHash("sha256")
  .update(CSS).update(SCRIPT).update(DESIGN_NOTE).update(CSP).update("layout-v6 cards-v10 readable-1")
  .digest("hex").slice(0, 16)

const GROUPS = [
  ["current", "Current knowledge"],
  ["topic", "Topic folders"],
  ["archive", "Archived history"],
]
const GROUP_NAME = Object.fromEntries(GROUPS)

const LARGE_FOLDER_THRESHOLD = 24
const isLargeFolder = (node) => node.kind === "folder" && node.docIds.length > LARGE_FOLDER_THRESHOLD
const humanizeArea = (name) => name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

function folderAreas(node, snapshot) {
  const docsById = new Map(snapshot.docs.map((doc) => [doc.id, doc]))
  const members = node.docIds.map((id) => docsById.get(id))
  const areas = new Map()
  for (const doc of members) {
    const rel = doc.rel.startsWith(node.rel) ? doc.rel.slice(node.rel.length) : doc.rel
    const cut = rel.indexOf("/")
    const key = cut === -1 ? "" : rel.slice(0, cut)
    if (!areas.has(key)) areas.set(key, [])
    areas.get(key).push(doc)
  }
  const groupedAreas = [...areas].map(([key, docs]) => ({ key, name: key ? humanizeArea(key) : "Programme records", docs }))
    .sort((a, b) => b.docs.length - a.docs.length || a.name.localeCompare(b.name))
  return { id: node.id, members, areas: groupedAreas, grouped: isLargeFolder(node) || groupedAreas.some((area) => area.key), large: isLargeFolder(node) }
}

const folderCount = (node, folder, noun) => `${folder.large ? `${folder.areas.length} area${folder.areas.length === 1 ? "" : "s"} · ` : ""}${node.weight} ${noun}${node.weight === 1 ? "" : "s"}`

function folderAreaDetails(folder, renderDocuments) {
  if (!folder.grouped) return renderDocuments(folder.members)
  return folder.areas.map((area) => `<details class="folder-area" data-folder="${folder.id}" data-area="${esc(area.key || "root")}"><summary>${esc(area.name)}<small>${area.docs.length} doc${area.docs.length === 1 ? "" : "s"}</small></summary>${renderDocuments(area.docs)}</details>`).join("")
}

function folderCatalogContent(folder, openItem, renderItem, listClass = "sub") {
  if (!folder.grouped) return `<ul class="${listClass}">${openItem}${folder.members.map(renderItem).join("")}</ul>`
  return `<ul class="${listClass}">${openItem}</ul>${folderAreaDetails(folder, (docs) => `<ul class="${listClass}">${docs.map(renderItem).join("")}</ul>`)}`
}

/** Deterministic radial layout: hub centre, topics on a ring in group sectors, folder members on satellite rings. */
function layout(model) {
  const hub = model.nodes.find((n) => n.kind === "hub") ?? null
  const ring = model.nodes.filter((n) => n !== hub).sort((a, b) => GROUPS.findIndex((g) => g[0] === a.group) - GROUPS.findIndex((g) => g[0] === b.group) || a.title.localeCompare(b.title))
  const placed = new Map()
  for (const node of ring) {
    const r = node.kind === "folder" ? 26 + Math.min(10, Math.sqrt(node.weight) * 2) : 22 + Math.min(10, node.facts / 4)
    // Satellite rings are hidden at fit level (shown when the folder is selected or zoomed in), so only
    // the body and label need angular room.
    const ringR = node.kind === "folder" && !isLargeFolder(node) ? Math.max(90, (26 * node.weight) / (2 * Math.PI)) : 0
    placed.set(node.id, { node, r, ringR, width: 2 * r + 112 })
  }
  const gap = 0.2
  const total = [...placed.values()].reduce((sum, p) => sum + p.width, 0)
  const groupsPresent = [...new Set(ring.map((n) => n.group))]
  const R = Math.max(520, total / (2 * Math.PI - gap * groupsPresent.length))
  let angle = -Math.PI / 2 + gap / 2
  const sectors = []
  let currentGroup = null
  for (const node of ring) {
    const p = placed.get(node.id)
    const span = p.width / R
    if (node.group !== currentGroup) {
      if (currentGroup) {
        sectors[sectors.length - 1].end = angle - gap / 2
        angle += gap
      }
      currentGroup = node.group
      sectors.push({ group: node.group, start: angle - gap / 2, end: null })
    }
    p.angle = angle + span / 2
    p.x = Math.cos(p.angle) * R
    p.y = Math.sin(p.angle) * R
    angle += span
  }
  if (sectors.length) sectors[sectors.length - 1].end = angle + gap / 2 - gap
  if (hub) placed.set(hub.id, { node: hub, r: 46, ringR: 0, x: 0, y: 0, angle: 0 })
  const docs = new Map()
  for (const p of placed.values()) {
    if (p.node.kind !== "folder" || isLargeFolder(p.node)) continue
    p.node.docIds.forEach((docId, i) => {
      const a = (i / p.node.docIds.length) * Math.PI * 2 - Math.PI / 2
      docs.set(docId, { x: p.x + Math.cos(a) * p.ringR, y: p.y + Math.sin(a) * p.ringR, parent: p.node.id, angle: a })
    })
  }
  // Labels sit outside the ring, so the horizontal padding leaves room for a two-line label.
  const padX = 300, padY = 120
  let minX = -R - padX, maxX = R + padX, minY = -R - padY, maxY = R + padY
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x - p.r - padX)
    maxX = Math.max(maxX, p.x + p.r + padX)
    minY = Math.min(minY, p.y - p.r - padY)
    maxY = Math.max(maxY, p.y + p.r + padY)
  }
  return { hub, placed, docs, sectors, R, box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } }
}

function wrapLabel(title, max = 16, lines = 2) {
  const words = title.split(/\s+/)
  const out = [""]
  for (const word of words) {
    const line = out[out.length - 1]
    if ((line + " " + word).trim().length <= max || !line) out[out.length - 1] = (line + " " + word).trim()
    else if (out.length < lines) out.push(word)
    else {
      out[out.length - 1] = out[out.length - 1].slice(0, max - 1) + "…"
      break
    }
  }
  return out
}

function arcPath(start, end, r1, r2) {
  const p = (a, r) => `${num(Math.cos(a) * r)} ${num(Math.sin(a) * r)}`
  const large = end - start > Math.PI ? 1 : 0
  return `M${p(start, r1)} A${r1} ${r1} 0 ${large} 1 ${p(end, r1)} L${p(end, r2)} A${r2} ${r2} 0 ${large} 0 ${p(start, r2)} Z`
}

function renderMap(snapshot, L, docsById) {
  const { model } = snapshot
  const parts = []
  parts.push(`<g class="sectors">`)
  for (const s of L.sectors) {
    parts.push(`<path class="sector ${s.group}" d="${arcPath(s.start, s.end, L.R - 170, L.R + 260)}"></path>`)
    const mid = (s.start + s.end) / 2
    const lr = L.R + 230
    const x = Math.cos(mid) * lr, y = Math.sin(mid) * lr
    const count = model.nodes.filter((n) => n.group === s.group && n.kind !== "hub").length
    parts.push(`<text class="sector-label" x="${num(x)}" y="${num(y)}" text-anchor="middle" dominant-baseline="middle">${esc(GROUP_NAME[s.group])} · ${count}</text>`)
  }
  parts.push(`</g><g class="edges">`)
  for (const edge of model.edges) {
    const a = L.placed.get(edge.a), b = L.placed.get(edge.b)
    if (!a || !b) continue
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    const cx = mx * 0.45, cy = my * 0.45
    const w = edge.count >= 5 ? "w3" : edge.count >= 2 ? "w2" : ""
    parts.push(`<path class="edge ${w}" data-edge="${edge.id}" data-a="${edge.a}" data-b="${edge.b}" d="M${num(a.x)} ${num(a.y)} Q${num(cx)} ${num(cy)} ${num(b.x)} ${num(b.y)}"><title>${esc(a.node.title)} ↔ ${esc(b.node.title)}: ${esc(edge.label)}</title></path>`)
    const lx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x, ly = 0.25 * a.y + 0.5 * cy + 0.25 * b.y
    parts.push(`<text class="edge-label" data-edge-label="${edge.id}" x="${num(lx)}" y="${num(ly)}" text-anchor="middle">${esc(edge.label)}</text>`)
  }
  parts.push(`</g><g class="nodes">`)
  for (const p of L.placed.values()) {
    const n = p.node
    const outward = n.kind === "hub" ? 0 : Math.cos(p.angle)
    const anchor = n.kind === "hub" ? "middle" : Math.abs(outward) < 0.35 ? "middle" : outward > 0 ? "start" : "end"
    const lx = n.kind === "hub" ? 0 : Math.cos(p.angle) * (p.r + 18)
    const ly = n.kind === "hub" ? p.r + 40 : Math.sin(p.angle) * (p.r + 18) + (Math.abs(outward) < 0.35 ? (Math.sin(p.angle) > 0 ? 30 : -12) : 10)
    const lines = wrapLabel(n.title, n.kind === "hub" ? 26 : 16)
    const areas = n.kind === "folder" ? folderAreas(n, snapshot) : null
    const meta = n.kind === "folder" ? `${folderCount(n, areas, "document")}${n.facts ? ` · ${n.facts} fact${n.facts === 1 ? "" : "s"}` : ""}` : `${n.sections} section${n.sections === 1 ? "" : "s"}${n.facts ? ` · ${n.facts} fact${n.facts === 1 ? "" : "s"}` : ""}`
    const aria = `${n.kind === "folder" ? (n.archived ? "Run record folder" : "Topic folder") : n.kind === "hub" ? "Project hub" : "Topic"}: ${n.title}. ${meta}. ${n.degree} connection${n.degree === 1 ? "" : "s"}.`
    parts.push(`<g class="node ${n.kind} ${n.group}" data-node="${n.id}" tabindex="0" role="button" aria-label="${esc(aria)}" transform="translate(${num(p.x)} ${num(p.y)})">`)
    parts.push(`<circle class="hit" r="${Math.max(26, p.r + 6)}"></circle>`)
    if (n.kind === "folder" && !isLargeFolder(n)) {
      parts.push(`<circle class="ring" r="${num(p.ringR)}"></circle><g class="sats">`)
      for (const docId of n.docIds) {
        const s = L.docs.get(docId)
        const doc = docsById.get(docId)
        const facts = model.docMeta[docId]?.facts ?? 0
        const sx = s.x - p.x, sy = s.y - p.y
        const label = doc.kind === "status" ? "status.tsv" : doc.title
        parts.push(`<line class="spoke" x1="0" y1="0" x2="${num(sx)}" y2="${num(sy)}"></line>`)
        parts.push(`<g class="sat ${doc.kind === "status" ? "status" : ""} ${facts ? "has-facts" : ""}" data-doc="${docId}" data-node="${n.id}" tabindex="-1" role="button" aria-label="${esc(`${label} (${doc.rel})`)}" transform="translate(${num(sx)} ${num(sy)})"><circle r="${facts ? 10 : 8}"></circle><text x="${Math.cos(s.angle) >= 0 ? 14 : -14}" y="6" text-anchor="${Math.cos(s.angle) >= 0 ? "start" : "end"}">${esc(label.length > 34 ? label.slice(0, 33) + "…" : label)}</text></g>`)
      }
      parts.push(`</g>`)
    }
    parts.push(`<circle class="body" r="${num(p.r)}"></circle>`)
    parts.push(`<text class="label" x="${num(lx)}" y="${num(ly)}" text-anchor="${anchor}">${lines.map((line, i) => `<tspan x="${num(lx)}" dy="${i ? 32 : 0}">${esc(line)}</tspan>`).join("")}</text>`)
    parts.push(`<text class="meta" x="${num(lx)}" y="${num(ly + 32 * (lines.length - 1) + 26)}" text-anchor="${anchor}">${esc(meta)}</text>`)
    parts.push(`</g>`)
  }
  parts.push(`</g>`)
  return parts.join("")
}

function renderMini(L) {
  const dots = [...L.placed.values()].map((p) => `<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${p.r + 6}"></circle>`).join("")
  return `<svg viewBox="${num(L.box.x)} ${num(L.box.y)} ${num(L.box.w)} ${num(L.box.h)}" aria-hidden="true">${dots}<rect class="vp" x="${num(L.box.x)}" y="${num(L.box.y)}" width="${num(L.box.w)}" height="${num(L.box.h)}"></rect></svg>`
}

// Readable mode labels citations with the plain part and note titles; the raw heading, path and line stay in the tooltip.
const cite = (item, label) => P.active ? citePlain(item, label) : `<button type="button" class="cite" data-open-doc="${item.docId}" data-open-section="${item.sectionId}"><span aria-hidden="true">§</span> ${esc(label ?? `${item.heading} · ${item.rel}${item.line == null ? "" : `:${item.line}`}`)}</button>`

// Readable mode (MEMORY-KNOWLEDGE-ELI5, 2026-10-25): a present memory.readable.json switches cards to plain
// explanations with the original behind closed "View source"; without it the view stays as before.
const NEEDS = '<span class="needs">Plain-language explanation needs updating.</span>'
let P = { active: false }

function citePlain(item, label) {
  const raw = label ?? `${item.heading} · ${item.rel}${item.line == null ? "" : `:${item.line}`}`
  const human = [P.section(item.docId, item.sectionId)?.title, P.doc(item.docId)?.title].filter(Boolean).join(" · ") || "Source note"
  return `<button type="button" class="cite" data-open-doc="${item.docId}" data-open-section="${item.sectionId}" title="${esc(raw)}"><span aria-hidden="true">§</span> ${esc(human)}</button>`
}

function plainLayer(snapshot) {
  const r = snapshot.readable
  if (!r || r.state === "absent") return { active: false }
  const doc = (id) => r.docs.get(id) ?? null
  return {
    active: true, r,
    doc,
    section: (docId, id) => doc(docId)?.sections.get(id) ?? null,
    fact: (f) => doc(f.docId)?.facts.get(f.id) ?? null,
    record: (t) => doc(t.docId)?.records.get(t.line) ?? null,
  }
}

const sourceFields = (fact) => `<p>${fact.factHtml}</p>${fact.whyHtml ? `<div class="field why"><b>Why</b><div>${fact.whyHtml}</div></div>` : ""}${fact.howHtml ? `<div class="field how"><b>How to apply</b><div>${fact.howHtml}</div></div>` : ""}`

function factCard(fact) {
  if (P.active) {
    const kind = { rule: "Rule", decision: "Decision", issue: "Recorded note" }[fact.kind]
    const p = P.fact(fact)
    const head = `<span class="chip ${fact.kind}">${kind}</span> ${fact.archived ? '<span class="chip archive">from a past run record</span> ' : ""}`
    const body = p ? `<p>${head}${esc(p.fact)}</p>${p.why ? `<div class="field why"><b>Why</b><div>${esc(p.why)}</div></div>` : ""}${p.how ? `<div class="field how"><b>How to apply</b><div>${esc(p.how)}</div></div>` : ""}` : `<p>${head}${NEEDS}</p>`
    return `<article class="card fact ${fact.kind}" id="${fact.id}">${body}<details class="sec src"><summary>View source<small>original text</small></summary><div>${sourceFields(fact)}</div></details>${cite(fact)}</article>`
  }
  const kind = { rule: "Rule", decision: "Decision", issue: "Issue" }[fact.kind]
  return `<article class="card fact ${fact.kind}" id="${fact.id}"><p><span class="chip ${fact.kind}">${kind}</span> ${fact.archived ? '<span class="chip archive">archived record</span> ' : ""}${fact.factHtml}</p>${fact.whyHtml ? `<div class="field why"><b>Why</b><div>${fact.whyHtml}</div></div>` : ""}${fact.howHtml ? `<div class="field how"><b>How to apply</b><div>${fact.howHtml}</div></div>` : ""}${cite(fact)}</article>`
}

function sectionsOf(doc, model) {
  const chunks = doc.html.split(/(?=<h[1-6] id=")/)
  const own = model.sections.filter((s) => s.docId === doc.id)
  if (doc.kind !== "markdown") return [{ id: doc.id, heading: doc.title, html: doc.html, level: 0 }]
  // Chunk n follows heading n; the preamble chunk only exists when the document does not open with a heading.
  const offset = /^<h[1-6] id="/.test(chunks[0] ?? "") ? 1 : 0
  return own.map((s) => {
    const n = s.id === doc.id ? 0 : Number(s.id.split("-h")[1])
    return { id: s.id, heading: s.heading, level: s.level, html: chunks[n - offset] ?? "" }
  })
}

function docCard(doc, snapshot, nodeTitle) {
  const { model } = snapshot
  const facts = model.facts.filter((f) => f.docId === doc.id)
  const out = model.refs.filter((r) => r.from === doc.id)
  const inbound = model.refs.filter((r) => r.to === doc.id)
  const sections = sectionsOf(doc, model)
  const node = model.nodes.find((n) => n.docIds.includes(doc.id))
  const related = (refs, dir) => refs.map((r) => {
    const target = dir === "out" ? (r.toKind === "folder" ? model.nodes.find((n) => n.id === r.to) : snapshot.docs.find((d) => d.id === r.to)) : snapshot.docs.find((d) => d.id === r.from)
    if (!target) return ""
    const attr = dir === "out" && r.toKind === "folder" ? `data-open-node="${r.to}"` : `data-open-doc="${target.id}"`
    if (P.active) {
      const name = `<button type="button" class="link" ${attr}>${esc(target.title)}</button>`
      const say = dir === "out" ? `This note ${r.kind === "link" ? "links to" : "mentions"} ${name}.` : `${name} ${r.kind === "link" ? "links to" : "mentions"} this note.`
      return `<li><p>${say}</p><details class="sec"><summary>Technical details<small>${r.kind === "link" ? "Markdown link" : "path mention"}</small></summary><div><p class="ex">${dir === "out" ? "From" : "In"} § ${esc(r.heading)}: “${esc(r.excerpt)}”</p></div></details></li>`
    }
    return `<li><button type="button" class="link" ${attr}>${esc(target.title)}</button> <small class="chip ${r.kind === "link" ? "decision" : "current"}">${r.kind === "link" ? "Markdown link" : "path mention"}</small><p class="ex">${dir === "out" ? "From" : "In"} § ${esc(r.heading)}: “${esc(r.excerpt)}”</p></li>`
  }).join("")
  if (P.active) {
    const p = P.doc(doc.id)
    const parts = sections.map((s) => { const ps = P.section(doc.id, s.id); return `<article class="card plain-sec" data-section="${s.id}"><h3>${esc(ps?.title || "Part needing a plain-language update")}</h3><p>${ps ? esc(ps.explanation) : NEEDS}</p></article>` }).join("")
    const tech = `<details class="sec tech"><summary>Technical details<small>path, hash and headings</small></summary><div><dl><dt>Source file</dt><dd class="mono">${esc(doc.rel)}</dd><dt>Original title</dt><dd>${esc(doc.sourceTitle ?? doc.title)}</dd><dt>Kind</dt><dd>${doc.kind === "status" ? "status record" : "Markdown"}</dd><dt>SHA-256</dt><dd class="mono">${doc.sha256}</dd><dt>File modified</dt><dd>${esc(stamp(doc.mtime))}</dd><dt>Redactions</dt><dd>${doc.redactions}</dd><dt>Headings</dt><dd>${sections.map((s) => esc(s.heading || doc.title)).join(" · ")}</dd></dl></div></details>`
    const source = `<details class="sec src" data-source="${doc.id}"><summary>View source<small>${sections.length} section${sections.length === 1 ? "" : "s"}, complete original text</small></summary><div>${sections.map((s) => `<details class="sec" data-source-section="${s.id}"><summary>${esc(s.heading || doc.title)}<small>${s.level ? `h${s.level}` : "preamble"}</small></summary><div>${s.html || '<p class="empty">No text under this heading.</p>'}</div></details>`).join("")}</div></details>`
    return `<section class="card-root" id="${doc.id}" data-card="${doc.id}" hidden>
<div class="node-head"><h2>${esc(doc.id === model.hubId ? snapshot.name : doc.title)}</h2><div class="kv"><span class="chip ${node?.archived ? "archive" : "current"}">${node?.archived ? "Archived history" : "Top-level note"}</span>${nodeTitle ? `<span>in <button type="button" class="link" data-open-node="${node.id}">${esc(nodeTitle)}</button></span>` : ""}<span>${sections.length} part${sections.length === 1 ? "" : "s"}</span><span>${facts.length} card${facts.length === 1 ? "" : "s"}</span></div><p class="lead">${p?.explanation ? esc(p.explanation) : NEEDS}</p></div>
<h2 class="board">What this note says</h2>${parts}
${facts.length ? `<h2 class="board">Knowledge cards</h2>${facts.map(factCard).join("")}` : ""}
${out.length || inbound.length ? `<h2 class="board">Related notes</h2><ul class="related">${related(out, "out")}${related(inbound, "in")}</ul>` : ""}
<h2 class="board">Original source</h2>${tech}${source}
</section>`
  }
  return `<section class="card-root" id="${doc.id}" data-card="${doc.id}" hidden>
<div class="node-head"><h2>${esc(doc.id === model.hubId ? snapshot.name : doc.title)}</h2><div class="kv"><span class="chip ${node?.archived ? "archive" : "current"}">${node?.archived ? "Archived history" : "Current source"}</span>${doc.id === model.hubId ? `<span>Source title: ${esc(doc.title)}</span>` : ""}${nodeTitle ? `<span>in <button type="button" class="link" data-open-node="${node.id}">${esc(nodeTitle)}</button></span>` : ""}<span>${doc.kind === "status" ? "status record" : "Markdown"}</span><span>${sections.length} section${sections.length === 1 ? "" : "s"}</span><span>${facts.length} fact${facts.length === 1 ? "" : "s"}</span><span>file modified ${esc(stamp(doc.mtime))}</span>${doc.redactions ? `<span>${doc.redactions} redaction${doc.redactions === 1 ? "" : "s"}</span>` : ""}</div><div class="path mono">${esc(doc.rel)}</div></div>
${facts.length ? `<h2 class="board">Knowledge cards</h2>${facts.map(factCard).join("")}` : ""}
${out.length || inbound.length ? `<h2 class="board">Related concepts</h2><ul class="related">${related(out, "out")}${related(inbound, "in")}</ul>` : ""}
<h2 class="board">Source sections (complete text)</h2>
${sections.map((s) => `<details class="sec" data-section="${s.id}" ${sections.length === 1 ? "open" : ""}><summary>${esc(s.heading || doc.title)}<small>${s.level ? `h${s.level}` : "preamble"}</small></summary><div>${s.html || '<p class="empty">No text under this heading.</p>'}</div></details>`).join("")}
</section>`
}

function folderCard(node, snapshot) {
  const { model } = snapshot
  const folder = folderAreas(node, snapshot)
  const { members } = folder
  const facts = model.facts.filter((f) => f.nodeId === node.id)
  const edges = model.edges.filter((e) => e.a === node.id || e.b === node.id)
  const plainDocuments = (docs) => `<ul class="related">${docs.map((doc) => `<li><button type="button" class="link" data-open-doc="${doc.id}">${esc(doc.title)}</button><p class="ex">${P.doc(doc.id)?.explanation ? esc(P.doc(doc.id).explanation) : NEEDS}</p></li>`).join("")}</ul>`
  const documents = (docs) => `<ul class="related">${docs.map((doc) => `<li><button type="button" class="link" data-open-doc="${doc.id}">${esc(doc.title)}</button> <small class="chip ${doc.kind === "status" ? "status" : "current"}">${doc.kind === "status" ? "status record" : "Markdown"}</small><p class="ex mono">${esc(doc.rel)} · ${model.docMeta[doc.id]?.sections ?? 0} sections · ${model.docMeta[doc.id]?.facts ?? 0} facts</p></li>`).join("")}</ul>`
  if (P.active) {
    return `<section class="card-root" id="${node.id}" data-card="${node.id}" hidden>
<div class="node-head"><h2>${esc(node.title)}</h2><div class="kv"><span class="chip ${node.archived ? "archive" : "current"}">${node.archived ? "Archived history" : "Topic folder"}</span><span>${folderCount(node, folder, "note")}</span><span>${facts.length} card${facts.length === 1 ? "" : "s"}</span></div>${node.archived ? '<p class="notice">These notes record what happened during one past run. They are history, not a statement of how things are now.</p>' : ""}</div>
<h2 class="board">Notes in this folder</h2>${folderAreaDetails(folder, plainDocuments)}
${edges.length ? `<h2 class="board">Related notes</h2><ul class="related">${edges.map((e) => { const other = model.nodes.find((n) => n.id === (e.a === node.id ? e.b : e.a)); return `<li><p>${e.count} reference${e.count === 1 ? "" : "s"} connect this folder and <button type="button" class="link" data-open-node="${other.id}">${esc(other.title)}</button>.</p><details class="sec"><summary>Technical details<small>${esc(e.label)}</small></summary><div>${e.refs.slice(0, 3).map((r) => `<p class="ex">§ ${esc(r.heading)} (${esc(snapshot.docs.find((d) => d.id === r.from)?.rel ?? "")}): “${esc(r.excerpt)}”</p>`).join("")}</div></details></li>` }).join("")}</ul>` : ""}
${facts.length ? `<h2 class="board">Knowledge cards recorded in this folder</h2>${facts.map(factCard).join("")}` : ""}
<details class="sec tech"><summary>Technical details<small>folder path</small></summary><div><dl><dt>Folder</dt><dd class="mono">${esc(node.rel)}</dd>${members.map((doc) => `<dt>Note</dt><dd class="mono">${esc(doc.rel)}</dd>`).join("")}</dl></div></details>
</section>`
  }
  return `<section class="card-root" id="${node.id}" data-card="${node.id}" hidden>
<div class="node-head"><h2>${esc(node.title)}</h2><div class="kv"><span class="chip ${node.archived ? "archive" : "current"}">${node.archived ? "Archived history" : "Topic folder"}</span><span>${folderCount(node, folder, "document")}</span><span>${facts.length} fact${facts.length === 1 ? "" : "s"}</span><span>${edges.length} connection${edges.length === 1 ? "" : "s"}</span></div><div class="path mono">${esc(node.rel)}</div>${node.archived ? '<p class="notice">Archived run output. It records what happened at the time and does not define current truth; current knowledge lives in the top-level topic files.</p>' : ""}</div>
<h2 class="board">Contains</h2>${folderAreaDetails(folder, documents)}
${edges.length ? `<h2 class="board">Related concepts</h2><ul class="related">${edges.map((e) => { const other = model.nodes.find((n) => n.id === (e.a === node.id ? e.b : e.a)); return `<li><button type="button" class="link" data-open-node="${other.id}">${esc(other.title)}</button> <small class="chip decision">${esc(e.label)}</small>${e.refs.slice(0, 3).map((r) => `<p class="ex">§ ${esc(r.heading)} (${esc(r.rel ?? "")}${r.rel ? "" : snapshot.docs.find((d) => d.id === r.from)?.rel ?? ""}): “${esc(r.excerpt)}”</p>`).join("")}</li>` }).join("")}</ul>` : ""}
${facts.length ? `<h2 class="board">Knowledge cards recorded in this folder</h2>${facts.map(factCard).join("")}` : ""}
</section>`
}

function board(kind, facts, empty) {
  const current = facts.filter((f) => !f.archived), archived = facts.filter((f) => f.archived)
  return `${current.length ? current.map(factCard).join("") : `<p class="empty">${esc(empty)}</p>`}${archived.length ? `<details class="sec"><summary>${P.active ? "From past run records (history)" : "From archived run records (history)"}<small>${archived.length}</small></summary><div>${archived.map(factCard).join("")}</div></details>` : ""}`
}

function plainRecord(t) {
  const p = P.record(t)
  const fields = t.fields && Object.keys(t.fields).length ? `<div class="fields">${Object.entries(t.fields).map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join("")}</div>` : ""
  return `<span class="chip ${t.kind}">${t.kind === "changelog" ? "changelog entry" : "status row"}</span> ${t.archived ? '<span class="chip archive">past run record</span> ' : ""}<span class="sum">${p ? esc(p) : NEEDS}</span><div class="fields-wrap"><details class="sec"><summary>Technical details<small>as written</small></summary><div><p>${t.summaryHtml}</p>${fields}</div></details></div><div class="foot">${cite(t, `${t.rel}:${t.line}`)}</div>`
}

function timeline(model) {
  if (!model.timeline.length) return '<p class="empty">No dated changelog entries or status rows were found in this memory.</p>'
  const days = new Map()
  for (const t of model.timeline) (days.get(t.date) ?? days.set(t.date, []).get(t.date)).push(t)
  return [...days].map(([date, items]) => `<div class="day">${esc(date)} <small>· ${items.length} record${items.length === 1 ? "" : "s"}</small></div><ol class="tl">${items.map((t) => P.active ? `<li class="${t.kind}"><span class="when">${esc(t.time || "—")}</span>${plainRecord(t)}</li>` : `<li class="${t.kind}"><span class="when">${esc(t.time || "—")}</span><span class="chip ${t.kind}">${t.kind === "changelog" ? "changelog" : "status record"}</span> ${t.archived ? '<span class="chip archive">archived</span> ' : ""}<span class="sum">${t.summaryHtml}</span>${t.fields && Object.keys(t.fields).length ? `<div class="fields-wrap"><details class="sec"><summary>Fields<small>${Object.keys(t.fields).length}</small></summary><div class="fields">${Object.entries(t.fields).map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join("")}</div></details></div>` : ""}<div class="foot">${cite(t, `${t.rel}:${t.line}`)}</div></li>`).join("")}</ol>`).join("")
}

function sourcesTree(snapshot) {
  const { model } = snapshot
  const groups = GROUPS.map(([g, name]) => [name, model.nodes.filter((n) => n.group === g)]).filter(([, nodes]) => nodes.length)
  return groups.map(([name, nodes]) => `<li class="grp">${esc(name)}</li>${nodes.map((n) => {
    if (n.kind !== "folder") return `<li><button type="button" data-open-doc="${n.id}"><span class="sw ${n.kind === "hub" ? "hub" : "doc"}"></span>${esc(n.title)}<small class="mono">${esc(n.rel)}</small></button></li>`
    const folder = folderAreas(n, snapshot)
    const openItem = `<li><button type="button" data-open-node="${n.id}">Open folder<small class="mono">${esc(n.rel)}</small></button></li>`
    const renderItem = (doc) => `<li><button type="button" data-open-doc="${doc.id}">${esc(doc.title)}<small class="mono">${esc(doc.rel.slice(n.rel.length))}</small></button></li>`
    return `<li><details class="folder" data-folder="${n.id}"><summary><span class="sw ${n.archived ? "archive" : "topic"}"></span>${esc(n.title)}<small>${folderCount(n, folder, "doc")}</small></summary>${folderCatalogContent(folder, openItem, renderItem, "tree sub")}</details></li>`
  }).join("")}`).join("")
}

function census(snapshot) {
  const c = snapshot.census
  const other = Object.entries(c.otherTypes).map(([ext, n]) => `${ext} ×${n}`).join(", ")
  return `<div class="census"><dl><dt>Markdown documents</dt><dd>${c.markdown.files} (${(c.markdown.bytes / 1024).toFixed(0)} KiB)</dd><dt>Status records</dt><dd>${c.status.files}</dd><dt>Excluded</dt><dd>${c.excluded.length ? c.excluded.map((e) => `${esc(e.path)} (${esc(e.reason)})`).join("; ") : "none"}</dd><dt>Unavailable</dt><dd>${c.unavailable.length ? c.unavailable.map((u) => `${esc(u.path)} (${esc(u.error)})`).join("; ") : "none"}</dd><dt>Other file types ignored</dt><dd>${other || "none"}</dd><dt>Redacted secret-shaped strings</dt><dd>${c.redactions}</dd>${P.active ? `<dt>Plain-language file</dt><dd>${esc(readableState())}</dd>` : ""}<dt>Source hash</dt><dd class="mono">${snapshot.sourceHash.slice(0, 16)}</dd><dt>Built</dt><dd>${esc(stamp(snapshot.builtAt))}</dd></dl></div>`
}

function listView(snapshot) {
  const { model } = snapshot
  return GROUPS.map(([g, name]) => {
    const nodes = model.nodes.filter((n) => n.group === g)
    if (!nodes.length) return ""
    return `<h2>${esc(name)}</h2><ul>${nodes.map((n) => {
      if (n.kind !== "folder") return `<li><button type="button" data-node="${n.id}" aria-pressed="false"><span class="sw ${n.kind === "hub" ? "hub" : "doc"}"></span>${esc(n.title)}<small>${n.sections} sections · ${n.facts} facts · ${n.degree} links</small></button></li>`
      const folder = folderAreas(n, snapshot)
      const openItem = `<li><button type="button" data-node="${n.id}" aria-pressed="false">Open folder</button></li>`
      const renderItem = (doc) => `<li><button type="button" data-node="${n.id}" data-doc="${doc.id}">${esc(doc.title)}<small class="mono">${esc(doc.rel.slice(n.rel.length))}</small></button></li>`
      return `<li><details class="folder" data-folder="${n.id}"><summary><span class="sw ${n.archived ? "archive" : "topic"}"></span>${esc(n.title)}<small>${folderCount(n, folder, "doc")} · ${n.facts} facts · ${n.degree} links</small></summary>${folderCatalogContent(folder, openItem, renderItem)}</details></li>`
    }).join("")}</ul>`
  }).join("")
}

function pickView(snapshot) {
  const { model } = snapshot
  const nodes = GROUPS.flatMap(([g]) => model.nodes.filter((n) => n.group === g))
  return `<h2 id="pick-title">Choose a topic</h2><ul>${nodes.map((n) => {
    const folder = n.kind === "folder" ? folderAreas(n, snapshot) : null
    return `<li><button type="button" data-node="${n.id}" aria-pressed="false">${esc(n.title)}<small>${n.kind === "folder" ? folderCount(n, folder, "doc") : `${n.sections} sections`} · ${n.facts} facts</small></button></li>`
  }).join("")}</ul>`
}

function coverage(snapshot) {
  const { model } = snapshot
  const share = (items, has) => [items.filter(has).length, items.length]
  const [s, sn] = share(model.sections, (x) => P.section(x.docId, x.id))
  const [f, fn] = share(model.facts, (x) => P.fact(x))
  const [t, tn] = share(model.timeline, (x) => P.record(x))
  return { s, sn, f, fn, t, tn }
}

function readableState() {
  const r = P.r
  return r.state === "invalid" ? `unavailable: ${r.message}` : `valid (${r.docs.size} notes current, ${r.stale.length} need updating, ${r.orphaned.length} refer to missing notes, ${r.redactions} redactions)`
}

function readableNotice(snapshot) {
  const r = P.r
  if (r.state === "invalid") return `<p class="notice">Plain-language explanations are unavailable. ${esc(r.message)} Every part shows “Plain-language explanation needs updating”, and the original text is under View source.</p>`
  const c = coverage(snapshot)
  const changed = r.stale.length ? ` ${r.stale.length} note${r.stale.length === 1 ? " has" : "s have"} changed since ${r.stale.length === 1 ? "its" : "their"} explanation was written, so ${r.stale.length === 1 ? "it shows" : "they show"} the original under View source until rewritten.` : ""
  const gone = r.orphaned.length ? ` ${r.orphaned.length} explanation${r.orphaned.length === 1 ? " refers" : "s refer"} to a note that no longer exists and ${r.orphaned.length === 1 ? "is" : "are"} not shown.` : ""
  return `<p class="${changed || gone || c.s < c.sn || c.f < c.fn || c.t < c.tn ? "notice" : "lead"}">Plain-language explanations cover ${c.s} of ${c.sn} parts, ${c.f} of ${c.fn} knowledge cards and ${c.t} of ${c.tn} dated records. The original notes stay the authority.${changed}${gone}</p>`
}

function overview(snapshot) {
  const { model } = snapshot
  if (P.active) return plainOverview(snapshot)
  const hub = snapshot.docs.find((d) => d.id === model.hubId)
  const c = model.counts
  const current = model.facts.filter((f) => !f.archived)
  const decisions = current.filter((f) => f.kind === "rule" || f.kind === "decision").slice(0, 6)
  const issues = current.filter((f) => f.kind === "issue").slice(0, 4)
  const recent = model.timeline.slice(0, 4)
  const more = (tab, n, label) => `<p><button type="button" class="link" data-tab-link="${tab}">${label} (${n})</button></p>`
  return `<div class="node-head"><h2>${esc(snapshot.name)}</h2><div class="kv"><span>${c.nodes} topics on the map</span><span>${c.edges} source-grounded connections (${c.references} references)</span><span>${c.facts} knowledge cards</span><span>${c.timeline} dated records</span>${hub ? `<span>Source title: ${esc(hub.title)}</span>` : ""}</div></div>
<h2 class="board">Latest dated records</h2>
${recent.length ? `<ol class="tl">${recent.map((t) => `<li class="${t.kind}"><span class="when">${esc(t.date)} ${esc(t.time || "")}</span><span class="chip ${t.kind}">${t.kind === "changelog" ? "changelog" : "status record"}</span> ${t.archived ? '<span class="chip archive">archived</span> ' : ""}<span class="sum">${t.summaryHtml}</span><div class="foot">${cite(t, `${t.rel}:${t.line}`)}</div></li>`).join("")}</ol>${more("timeline", c.timeline, "All dated records")}` : '<p class="empty">No dated changelog entries or status rows found.</p>'}
<h2 class="board">Decisions and rules from current sources</h2>
${decisions.length ? decisions.map(factCard).join("") + more("decisions", model.facts.filter((f) => f.kind !== "issue").length, "All decisions and rules") : '<p class="empty">No Why/How-to-apply records in current sources.</p>'}
<h2 class="board">Issues and constraints from current sources</h2>
${issues.length ? issues.map(factCard).join("") + more("issues", model.facts.filter((f) => f.kind === "issue").length, "All issues and constraints") : '<p class="empty">No issue or constraint sections in current sources.</p>'}
<h2 class="board">Source</h2>
${hub ? `<details class="sec" data-overview-source="${hub.id}"><summary>${esc(hub.rel)} complete text<small>${model.sections.filter((s) => s.docId === hub.id).length} sections</small></summary><div>${sectionsOf(hub, model).map((s) => s.html).join("")}</div></details>` : ""}
<details class="sec"><summary>Coverage and census<small>${snapshot.docs.length} documents</small></summary><div>${census(snapshot)}</div></details>`
}

function plainOverview(snapshot) {
  const { model } = snapshot
  const hub = snapshot.docs.find((d) => d.id === model.hubId)
  const c = model.counts
  const current = model.facts.filter((f) => !f.archived)
  const decisions = current.filter((f) => f.kind === "rule" || f.kind === "decision").slice(0, 6)
  const issues = current.filter((f) => f.kind === "issue").slice(0, 4)
  const recent = model.timeline.slice(0, 4)
  const more = (tab, n, label) => `<p><button type="button" class="link" data-tab-link="${tab}">${label} (${n})</button></p>`
  const intro = hub && P.doc(hub.id)?.explanation
  return `<div class="node-head"><h2>${esc(snapshot.name)}</h2><div class="kv"><span>${c.nodes} topics on the map</span><span>${c.facts} knowledge cards</span><span>${c.timeline} dated records</span></div>${hub ? `<p class="lead">${intro ? esc(intro) : NEEDS}</p>` : ""}${readableNotice(snapshot)}</div>
<h2 class="board">Most recent dated records</h2><p class="lead">What each record reported at the time it was written. These are past entries, not a check of how things are today.</p>
${recent.length ? `<ol class="tl">${recent.map((t) => `<li class="${t.kind}"><span class="when">${esc(t.date)} ${esc(t.time || "")}</span>${plainRecord(t)}</li>`).join("")}</ol>${more("timeline", c.timeline, "All dated records")}` : '<p class="empty">No dated changelog entries or status rows found.</p>'}
<h2 class="board">Decisions and rules from top-level notes</h2>
${decisions.length ? decisions.map(factCard).join("") + more("decisions", model.facts.filter((f) => f.kind !== "issue").length, "All decisions and rules") : '<p class="empty">No Why/How-to-apply records in top-level notes.</p>'}
<h2 class="board">Recorded notes, limits and open questions from top-level notes</h2>
${issues.length ? issues.map(factCard).join("") + more("issues", model.facts.filter((f) => f.kind === "issue").length, "All recorded notes") : '<p class="empty">No limitation or constraint sections in top-level notes.</p>'}
<h2 class="board">Original source</h2>
${hub ? `<details class="sec" data-overview-source="${hub.id}"><summary>View source: ${esc(hub.rel)}<small>${model.sections.filter((s) => s.docId === hub.id).length} sections</small></summary><div>${sectionsOf(hub, model).map((s) => s.html).join("")}</div></details>` : ""}
<details class="sec"><summary>Coverage and census<small>${snapshot.docs.length} documents</small></summary><div>${census(snapshot)}</div></details>`
}

/** Plain text a section contributes to search: its explanation and the plain cards recorded in it. */
function plainSearch(s, model) {
  const ps = P.section(s.docId, s.id)
  const facts = model.facts.filter((f) => f.sectionId === s.id).map((f) => P.fact(f)).filter(Boolean).map((p) => [p.fact, p.why, p.how].filter(Boolean).join(" "))
  return { pt: ps?.title ?? "", p: [ps?.title, ps?.explanation, ...facts].filter(Boolean).join("\n") }
}

/** Display copy with plain titles; the snapshot itself (and its original titles) is never mutated. */
function withPlainTitles(snapshot) {
  const title = (doc) => P.doc(doc.id)?.title || "Note needing a plain-language update"
  const docs = snapshot.docs.map((doc) => ({ ...doc, title: title(doc), sourceTitle: doc.title }))
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const nodes = snapshot.model.nodes.map((n) => (n.kind === "folder" ? { ...n } : { ...n, title: byId.get(n.id)?.title ?? n.title }))
  return { ...snapshot, docs, model: { ...snapshot.model, nodes } }
}

export function renderPage(snapshot, { mode, version = 1, status = "live" }) {
  P = plainLayer(snapshot)
  if (P.active) snapshot = withPlainTitles(snapshot)
  const { model } = snapshot
  // The hub carries the project's actual identity (its directory name); the INDEX H1 stays visible as the source title.
  const hubNode = model.nodes.find((n) => n.kind === "hub")
  if (hubNode) hubNode.title = snapshot.name
  const docsById = new Map(snapshot.docs.map((d) => [d.id, d]))
  const L = layout(model)
  const nodeTitle = Object.fromEntries(model.nodes.map((n) => [n.id, n.title]))
  const payload = {
    nodes: nodeTitle,
    docs: Object.fromEntries(snapshot.docs.map((d) => [d.id, { n: model.nodes.find((n) => n.docIds.includes(d.id))?.id ?? d.id, t: d.title, r: d.rel }])),
    edges: model.edges.map((e) => ({ id: e.id, a: e.a, b: e.b })),
    sections: model.sections.map((s) => ({ id: s.id, d: s.docId, n: s.nodeId, h: s.heading, r: s.rel, t: s.text, a: s.archived ? 1 : 0, ...(P.active ? plainSearch(s, model) : {}) })),
    ...(P.active ? { plain: 1 } : {}),
  }
  const json = JSON.stringify(payload).replace(/</g, "\\u003c")
  const c = model.counts
  const decisions = model.facts.filter((f) => f.kind === "rule" || f.kind === "decision")
  const issues = model.facts.filter((f) => f.kind === "issue")
  const cards = snapshot.docs.map((doc) => docCard(doc, snapshot, doc.folder ? nodeTitle[model.nodes.find((n) => n.docIds.includes(doc.id))?.id] : "")).join("") + model.nodes.filter((n) => n.kind === "folder").map((n) => folderCard(n, snapshot)).join("")
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP.replace("; frame-ancestors 'none'", "")}">
<meta name="referrer" content="no-referrer">
<meta name="memory-source-hash" content="${snapshot.sourceHash}">
<meta name="memory-template-hash" content="${TEMPLATE_HASH}">
<meta name="memory-built-at" content="${snapshot.builtAt}">
<title>${esc(snapshot.name)} · project memory map</title>
<style>${CSS}</style>
</head>
<body data-mode="${mode}" data-version="${version}" data-status="${status}" data-built="${snapshot.builtAt}" data-project="${esc(snapshot.name)}"><!--${DESIGN_NOTE}-->
<a class="skip" href="#panel">Skip to knowledge panel</a>
<header class="bar">
<div class="brand"><b>${esc(snapshot.name)} · memory map</b><small id="brand-sub">${c.nodes} topics · ${c.edges} connections · ${c.facts} cards · ${c.timeline} dated records · source ${snapshot.sourceHash.slice(0, 8)}</small></div>
<div class="search" role="search"><label class="skip" for="q">Search memory</label><input id="q" type="search" placeholder="Search every fact, section and record (press /)" autocomplete="off"></div>
<button type="button" class="btn" id="list-toggle" aria-pressed="false" aria-controls="list">List view</button>
<div class="status" id="status" role="status" aria-live="polite"><i aria-hidden="true"></i><span id="status-text">${mode === "live" ? "Live" : "Snapshot"}</span></div>
</header>
<main>
<section id="map" tabindex="0" aria-label="Knowledge map. Drag to pan, scroll to zoom, arrow keys to pan, plus and minus to zoom, Tab to move between topics." data-list="off" data-zoom="out">
<svg id="map-svg" viewBox="${num(L.box.x)} ${num(L.box.y)} ${num(L.box.w)} ${num(L.box.h)}" role="group" aria-labelledby="map-title"><title id="map-title">Knowledge map of ${esc(snapshot.name)}: ${c.nodes} topics, ${c.edges} connections from ${c.references} Markdown references</title><g id="world">${renderMap(snapshot, L, docsById)}</g></svg>
<div class="map-ui pos-tl"><div class="legend" aria-label="Legend"><h2>Legend</h2><ul><li><span class="sw hub"></span>Project hub (INDEX)</li><li><span class="sw doc"></span>Current topic file</li><li><span class="sw topic"></span>Topic folder</li><li><span class="sw archive"></span>Dated run record (history)</li><li><span class="ln"></span>Markdown reference</li><li><span class="ln dash"></span>Folder contains document</li></ul></div></div>
<div class="map-ui pos-tr"><button type="button" class="btn" id="zoom-in" aria-label="Zoom in">+</button><button type="button" class="btn" id="zoom-out" aria-label="Zoom out">−</button><button type="button" class="btn txt" id="zoom-fit" aria-label="Fit whole map">Fit</button><button type="button" class="btn txt" id="zoom-focus" aria-label="Focus selected topic">Focus</button></div>
<div class="map-ui pos-br"><div class="minimap" id="minimap" aria-hidden="true">${renderMini(L)}</div></div>
<nav id="list" aria-label="Topics as a list">${listView(snapshot)}</nav>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
</section>
<nav id="pick" aria-labelledby="pick-title">${pickView(snapshot)}</nav>
<aside id="panel" aria-label="Knowledge panel">
<div class="tabs" role="tablist">
<button type="button" role="tab" data-tab="knowledge" aria-selected="true">Knowledge</button>
<button type="button" role="tab" data-tab="decisions" aria-selected="false">Decisions &amp; rules<b>${decisions.length}</b></button>
<button type="button" role="tab" data-tab="issues" aria-selected="false"><span>${P.active ? "Recorded notes" : "Issues &amp; constraints"}</span><b>${issues.length}</b></button>
<button type="button" role="tab" data-tab="timeline" aria-selected="false">Timeline<b>${c.timeline}</b></button>
<button type="button" role="tab" data-tab="sources" aria-selected="false">Sources<b>${snapshot.docs.length}</b></button>
<button type="button" role="tab" data-tab="search" aria-selected="false">Search</button>
</div>
<div class="pane" id="knowledge" role="tabpanel" data-active><div id="overview">${overview(snapshot)}</div><div id="cards">${cards}</div></div>
<div class="pane" id="decisions" role="tabpanel"><h2 class="board">Decisions and rules with their reasons</h2><p class="lead">${P.active ? "Each card explains one record in plain words, with its reason and when it applies where the note gave them. The original wording is under View source. Archived records are kept apart." : "Each card is one record from the Markdown, split into fact, Why and How to apply where the source wrote them. Archived run records are kept apart."}</p>${board("decision", decisions, "No Why/How-to-apply records or decision sections were found.")}</div>
<div class="pane" id="issues" role="tabpanel">${P.active ? '<h2 class="board">Recorded notes, limits and open questions</h2><p class="lead">Items a note wrote under headings about issues, constraints, risks, blockers or open questions. Each one says what that note recorded at the time; it is not a check that the problem still exists.</p>' : '<h2 class="board">Issues, constraints and open questions</h2><p class="lead">Items recorded under headings about issues, constraints, risks, blockers or open questions.</p>'}${board("issue", issues, "No issue or constraint sections were found.")}</div>
<div class="pane" id="timeline" role="tabpanel"><h2 class="board">Memory timeline</h2><p class="lead">${c.changelog} dated changelog entries and ${c.statusRows} status rows, newest first. Dates are the ones written in the records; file modification times are shown on each document card instead.</p>${timeline(model)}</div>
<div class="pane" id="sources" role="tabpanel"><h2 class="board">All source documents</h2><ul class="tree">${sourcesTree(snapshot)}</ul><h2 class="board">Coverage</h2>${census(snapshot)}</div>
<div class="pane" id="search" role="tabpanel"><h2 class="board">Search results</h2><p class="lead" id="search-summary">Type at least two characters to search every fact, section and record.</p><ol id="results"></ol></div>
</aside>
</main>
<script type="application/json" id="model">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
  return { html, csp: CSP }
}
