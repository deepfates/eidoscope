// The default reader of the deck: a self-contained, offline HTML explorer. Position is a control,
// not a truth — switch between the neighbor map (MDE, faithful/meaningless-axes), scatter by any
// two discovered axes (interpretable), and a draggable 3D orbit. Color by region or any axis,
// size by influence, click a card for its neighbors. Frontier / deck-view / time are plugins.
import { writeFileSync, readFileSync } from "node:fs";

export type MapData = {
  ids: string[]; titles: string[]; cores: string[];
  notes: Record<string, string>[];
  axes: { key: string; name: string; low: string; high: string; weak?: boolean }[];
  scores: Record<string, number[]>;
  xy: number[][]; xyz: number[][]; cluster: number[]; k: number; hub: number[]; nbr: number[][];
  clusters: { c: number; n: number; label: string; cx: number; cy: number }[];
  urls?: (string | undefined)[]; authors?: (string | undefined)[]; tags?: (string[] | undefined)[]; dates?: (number | undefined)[];
  cite?: number[][]; citec?: number[];  // intra-corpus citation edges + impact (frontier telescope)
  ghosts?: { title: string; arxiv: string; url: string; n: number; core: string; xy: [number, number]; sim: number }[];
};

export function renderHTML(D: MapData): string {
  const nodes = D.ids.map((id, i) => ({
    id, i, t: (D.titles[i] || "").slice(0, 90), core: D.cores[i] || "", cl: D.cluster[i],
    xy: D.xy[i], xyz: D.xyz[i], notes: D.notes[i] || {}, hub: D.hub[i] || 0, nbr: D.nbr[i] || [],
    url: D.urls?.[i], author: D.authors?.[i], tags: D.tags?.[i], date: D.dates?.[i],
    sc: Object.fromEntries(D.axes.map((a) => [a.key, D.scores[a.key]?.[i] ?? 50])),
  }));
  const payload = JSON.stringify({ nodes, axes: D.axes, k: D.k, clusters: D.clusters, ghosts: D.ghosts || [], cite: D.cite || [], citec: D.citec || [] }).replace(/<\//g, "<\\/");
  return `<meta charset="utf-8"><title>eidoscope</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#0b0e15;--ink:#eef2fa;--soft:#93a1b7;--hair:#232c3c;--panel:#141b27;--sans:"Inter",system-ui,sans-serif;--mono:ui-monospace,Menlo,monospace}
:root[data-theme=light]{--bg:#f4f6fa;--ink:#161c28;--soft:#5a6578;--hair:#dde3ee;--panel:#fff}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--ink);font-family:var(--sans);overflow:hidden}
#c{position:fixed;inset:0;width:100%;height:100%;display:block;cursor:grab}#c.drag{cursor:grabbing}
.pane{position:fixed;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(10px);border:1px solid var(--hair);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
#hud{top:14px;left:14px;padding:12px 14px;width:290px}#hud .k{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft)}#hud h1{font-size:16px;margin:3px 0 9px;font-weight:800}
.ctl{display:flex;gap:8px;align-items:center;margin:5px 0;font-size:12px}.ctl label{font-family:var(--mono);font-size:10px;color:var(--soft);width:46px;flex:none}
select{flex:1;background:var(--bg);border:1px solid var(--hair);border-radius:7px;padding:5px 7px;font:12px var(--sans);color:var(--ink);min-width:0}
#q{width:100%;margin-top:7px;background:var(--bg);border:1px solid var(--hair);border-radius:7px;padding:6px 9px;font:12px var(--sans);color:var(--ink)}
.xy{display:none}.xy.on{display:flex}
#legend{bottom:14px;right:14px;padding:9px 11px;font-size:11px;max-width:250px;max-height:52vh;overflow:auto}#legend .r{display:flex;gap:7px;align-items:center;margin:2px 0}.sw{width:10px;height:10px;border-radius:2px;flex:none}
#tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .07s;max-width:330px;padding:11px 13px;font-size:11.5px;line-height:1.5;z-index:9}#tip .t{font-weight:700;margin-bottom:4px;font-size:12.5px}#tip .co{margin-bottom:6px}#tip .f{font-family:var(--mono);font-size:10px;color:var(--soft)}
#detail{top:14px;right:14px;width:290px;max-height:74vh;overflow:auto;padding:13px 15px;display:none;z-index:10}#detail.on{display:block}#detail .t{font-weight:800;font-size:13.5px;margin-bottom:5px}#detail .co{font-size:11.5px;line-height:1.5;color:var(--soft);margin-bottom:9px}#detail h4{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--soft);margin:10px 0 4px}#detail .nb{font-size:11.5px;padding:3px 5px;border-radius:5px;cursor:pointer}#detail .nb:hover{background:color-mix(in srgb,var(--ink) 12%,transparent)}#detail .x{position:absolute;top:9px;right:11px;cursor:pointer;color:var(--soft);font-family:var(--mono)}#detail .meta{font-family:var(--mono);font-size:10px;color:var(--soft);margin-bottom:6px}#detail .open{display:inline-block;margin:0 0 9px;font-family:var(--mono);font-size:11px;font-weight:700;color:hsl(210 90% 62%);text-decoration:none}#detail .open:hover{text-decoration:underline}#detail .ax{display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:3px 0;border-bottom:1px solid var(--hair)}#detail .axn{color:var(--soft)}#detail .axs{font-family:var(--mono);font-size:10px;white-space:nowrap}
#deck{top:14px;left:50%;transform:translateX(-50%);width:min(940px,88vw);max-height:82vh;overflow:auto;padding:12px 14px;display:none;z-index:11}#deck.on{display:block}
#deck .top{display:flex;gap:10px;align-items:center;margin-bottom:9px}#deck .top .x{margin-left:auto;cursor:pointer;color:var(--soft);font-family:var(--mono)}
#deck .top select,#deck .top input{background:var(--bg);border:1px solid var(--hair);border-radius:7px;padding:4px 8px;font:11px var(--sans);color:var(--ink)}
#deck .list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px}
#deck .card{border:1px solid var(--hair);border-radius:10px;padding:10px 12px;cursor:pointer;background:var(--bg)}#deck .card:hover{border-color:var(--soft)}
#deck .card .ct{font-weight:700;font-size:12.5px;margin-bottom:4px;line-height:1.25}#deck .card .cc{font-size:11px;color:var(--soft);line-height:1.42;margin-bottom:8px}
#deck .chips{display:flex;flex-wrap:wrap;gap:4px}#deck .chip{font-family:var(--mono);font-size:9px;padding:2px 7px;border-radius:20px;background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--soft);white-space:nowrap}#deck .chip.hi{color:var(--ink);background:color-mix(in srgb,var(--ink) 16%,transparent)}#deck .chip.reg{color:var(--ink)}
.ctrl2{position:fixed;top:14px;left:316px;display:flex;gap:8px;z-index:9;font-family:var(--mono);font-size:11px}.ctrl2 button{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--hair);border-radius:7px;padding:6px 9px;cursor:pointer}.ctrl2 button.on{background:var(--ink);color:var(--bg)}
#axhint{position:fixed;left:0;right:0;bottom:12px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--soft);pointer-events:none}#count{position:fixed;bottom:14px;left:14px;font-family:var(--mono);font-size:11px;color:var(--soft)}
</style>
<canvas id="c"></canvas>
<div id="hud" class="pane"><div class="k">eidoscope 🔭</div><h1>the forms of the corpus</h1>
<div class="ctl"><label>layout</label><select id="layout"><option value="mde">neighbor map (2D)</option><option value="orbit">3D orbit (drag)</option><option value="axes">axis scatter</option></select></div>
<div class="ctl xy" id="xrow"><label>x-axis</label><select id="xax"></select></div><div class="ctl xy" id="yrow"><label>y-axis</label><select id="yax"></select></div>
<div class="ctl"><label>color</label><select id="color"></select></div><div class="ctl"><label>size</label><select id="size"></select></div>
<input id="q" type="search" placeholder="find a card…"></div>
<div id="legend" class="pane"></div><div id="tip" class="pane"></div><div id="detail" class="pane"></div><div id="deck" class="pane"></div>
<div class="ctrl2"><button id="deckbtn">deck</button><button id="labels" class="on">labels</button>${(D.ghosts && D.ghosts.length) ? '<button id="frontbtn">frontier</button>' : ""}${(D.cite && D.cite.some((e) => e.length)) ? '<button id="citebtn">cite edges</button>' : ""}<button id="reset">reset</button><button id="theme">theme</button></div>
<div id="axhint"></div><div id="count"></div>
<script id="data" type="application/json">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);const {nodes,axes,k,clusters}=D;const ghosts=D.ghosts||[],cite=D.cite||[];let frontierOn=false,citeOn=false,ghover=null;const AX=Object.fromEntries(axes.map(a=>[a.key,a]));
const cv=document.getElementById('c'),ctx=cv.getContext('2d'),tip=document.getElementById('tip'),detailEl=document.getElementById('detail');
let W,H,DPR=Math.min(2,devicePixelRatio||1),view={s:1,x:0,y:0},hover=null,focus=null,hlCluster=null,layout='mde',xKey=axes[0].key,yKey=axes[1].key,color='cluster',sizeBy='hub',showLabels=true,rotY=0.5,rotX=-0.3;
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();const base=()=>Math.min(W,H)*0.44;const maxHub=Math.max(1,...nodes.map(n=>n.hub));
const jit=(id,s)=>{let h=(2166136261^Math.imul(s,374761393))>>>0;for(let i=0;i<id.length;i++)h=Math.imul(h^id.charCodeAt(i),16777619)>>>0;return((((h>>>9)%1000)/1000)-0.5)*0.14};
function proj3(n){const[a,b,cc]=n.xyz,cy=Math.cos(rotY),sy=Math.sin(rotY);let x=a*cy+cc*sy,z=-a*sy+cc*cy;const cx=Math.cos(rotX),sx=Math.sin(rotX);let y=b*cx-z*sx;z=b*sx+z*cx;return[x,y,z]}
function tgt(n){if(layout==='axes')return[(n.sc[xKey]-50)/50+jit(n.id,1),(n.sc[yKey]-50)/50+jit(n.id,7)];if(layout==='orbit'){const p=proj3(n);n.depth=Math.max(-1,Math.min(1,p[2]));return[p[0],p[1]]}return[n.xy[0],n.xy[1]]}
nodes.forEach(n=>{n.cur=tgt(n).slice(0,2);n.tg=n.cur.slice()});function retarget(){nodes.forEach(n=>{const t=tgt(n);n.tg=[t[0],t[1]]})}
const S=n=>{const b=base();return{x:W/2+n.cur[0]*b*view.s+view.x,y:H/2-n.cur[1]*b*view.s+view.y}};const Sxy=(x,y)=>{const b=base();return{x:W/2+x*b*view.s+view.x,y:H/2-y*b*view.s+view.y}};const gmax=Math.max(1,...ghosts.map(g=>g.n));
const HUES=[210,28,150,300,45,265,175,110,330,15,85,240,190,60,320,95];
function colOf(n){if(color==='cluster')return'hsl('+HUES[n.cl%HUES.length]+' 62% 60%)';const t=Math.max(0,Math.min(1,(n.sc[color]||0)/100));return'hsl('+(250-t*250)+' 74% '+(40+t*22)+'%)'}
function rad(n){let r=2.2;if(sizeBy==='hub')r=1.5+3.4*Math.sqrt(n.hub/maxHub);else if(sizeBy!=='uniform')r=1.5+3*Math.abs((n.sc[sizeBy]||50)-50)/50;if(layout==='orbit')r*=(0.6+0.5*((n.depth||0)+1)/2);return Math.max(0.2,r)}
function hull(pts){if(pts.length<3)return pts;pts=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);const L=[];for(const p of pts){while(L.length>=2&&cr(L[L.length-2],L[L.length-1],p)<=0)L.pop();L.push(p)}const U=[];for(let i=pts.length-1;i>=0;i--){const p=pts[i];while(U.length>=2&&cr(U[U.length-2],U[U.length-1],p)<=0)U.pop();U.push(p)}return L.slice(0,-1).concat(U.slice(0,-1))}
function draw(){ctx.setTransform(DPR,0,0,DPR,0,0);ctx.clearRect(0,0,W,H);const q=(document.getElementById('q').value||'').toLowerCase();const fs=focus?new Set([focus.i,...focus.nbr]):null;
  if(hlCluster!=null){const h=hull(nodes.filter(n=>n.cl===hlCluster).map(n=>{const p=S(n);return[p.x,p.y]}));if(h.length>2){ctx.beginPath();ctx.moveTo(h[0][0],h[0][1]);for(const p of h)ctx.lineTo(p[0],p[1]);ctx.closePath();ctx.fillStyle='hsl('+HUES[hlCluster%HUES.length]+' 62% 60% / .1)';ctx.fill();ctx.strokeStyle='hsl('+HUES[hlCluster%HUES.length]+' 62% 60% / .5)';ctx.lineWidth=1.5;ctx.stroke()}}
  if(focus){const fp=S(focus);ctx.strokeStyle=css('--ink');ctx.globalAlpha=.32;ctx.lineWidth=1;for(const j of focus.nbr){const p=S(nodes[j]);ctx.beginPath();ctx.moveTo(fp.x,fp.y);ctx.lineTo(p.x,p.y);ctx.stroke()}ctx.globalAlpha=1}
  if(citeOn&&layout==='mde'){ctx.strokeStyle=css('--soft');ctx.globalAlpha=.13;ctx.lineWidth=.6;for(let i=0;i<cite.length;i++){const a=S(nodes[i]);for(const j of cite[i]){const b=S(nodes[j]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}}ctx.globalAlpha=1}
  for(const n of nodes){const p=S(n);if(p.x<-8||p.x>W+8||p.y<-8||p.y>H+8)continue;let al=layout==='orbit'?0.4+0.55*((n.depth||0)+1)/2:0.9;if(q&&!(n.t.toLowerCase().includes(q)||n.core.toLowerCase().includes(q)))al=.05;if(fs&&!fs.has(n.i))al*=.12;if(hlCluster!=null&&n.cl!==hlCluster)al*=.14;ctx.globalAlpha=al;ctx.fillStyle=colOf(n);ctx.beginPath();ctx.arc(p.x,p.y,rad(n),0,7);ctx.fill()}ctx.globalAlpha=1;
  if(frontierOn&&layout==='mde'){for(const g of ghosts){const p=Sxy(g.xy[0],g.xy[1]);if(p.x<-8||p.x>W+8||p.y<-8||p.y>H+8)continue;const r=2+3*Math.sqrt(g.n/gmax);ctx.strokeStyle=g===ghover?css('--ink'):css('--soft');ctx.globalAlpha=g===ghover?1:.72;ctx.lineWidth=g===ghover?1.8:1.2;ctx.beginPath();ctx.arc(p.x,p.y,r,0,7);ctx.stroke()}ctx.globalAlpha=1}
  for(const h of[hover,focus]){if(h){const p=S(h);ctx.strokeStyle=css('--ink');ctx.lineWidth=1.8;ctx.beginPath();ctx.arc(p.x,p.y,rad(h)+3,0,7);ctx.stroke()}}
  if(showLabels&&color==='cluster'&&hlCluster==null){const cen={};for(const n of nodes){(cen[n.cl]=cen[n.cl]||[0,0,0]);cen[n.cl][0]+=n.cur[0];cen[n.cl][1]+=n.cur[1];cen[n.cl][2]++}ctx.textAlign='center';ctx.font='700 12px var(--sans)';for(const c of clusters){const g=cen[c.c];if(!g)continue;const px=W/2+(g[0]/g[2])*base()*view.s+view.x,py=H/2-(g[1]/g[2])*base()*view.s+view.y;ctx.fillStyle=css('--bg');ctx.globalAlpha=.72;const tw=ctx.measureText(c.label).width;ctx.fillRect(px-tw/2-5,py-9,tw+10,17);ctx.globalAlpha=1;ctx.fillStyle='hsl('+HUES[c.c%HUES.length]+' 62% 62%)';ctx.fillText(c.label,px,py+3)}}
  if(layout==='axes'){const tr=s=>{s=s||'';return s.length>46?s.slice(0,44)+'…':s};ctx.save();ctx.font='600 11.5px var(--sans)';ctx.fillStyle=css('--ink');ctx.globalAlpha=.85;ctx.textBaseline='middle';ctx.textAlign='left';ctx.fillText('← '+tr(AX[xKey].low),14,H/2);ctx.textAlign='right';ctx.fillText(tr(AX[xKey].high)+' →',W-14,H/2);ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText('↑ '+tr(AX[yKey].high),W/2,16);ctx.textBaseline='bottom';ctx.fillText('↓ '+tr(AX[yKey].low),W/2,H-34);ctx.restore()}
  document.getElementById('count').textContent=nodes.length+' cards · '+layout+(sizeBy!=='uniform'?' · size='+sizeBy:'');
  document.getElementById('axhint').innerHTML=layout==='axes'?'each card positioned by its score on the two axes'+((AX[xKey].weak||AX[yKey].weak)?' · <b>~</b> = the cards track this axis weakly':''):(layout==='orbit'?'drag to rotate':(focus?'showing '+focus.nbr.length+' nearest — click empty space to clear':'proximity = similarity · click a card for its neighbors'))}
let raf=null;function tick(){let m=false;for(const n of nodes)for(let d=0;d<2;d++){const df=n.tg[d]-n.cur[d];if(Math.abs(df)>1e-4){n.cur[d]+=df*.16;m=true}else n.cur[d]=n.tg[d]}draw();if(m)raf=requestAnimationFrame(tick);else raf=null}
function relayout(){retarget();if(!raf)raf=requestAnimationFrame(tick)}
function pick(mx,my){let b=null,bd=1e9;for(const n of nodes){const p=S(n);const d=(p.x-mx)**2+(p.y-my)**2;const rr=(rad(n)+4)**2;if(d<rr&&d<bd){bd=d;b=n}}return b}
function pickG(mx,my){if(!frontierOn||layout!=='mde')return null;let b=null,bd=1e9;for(const g of ghosts){const p=Sxy(g.xy[0],g.xy[1]);const r=2+3*Math.sqrt(g.n/gmax)+5;const d=(p.x-mx)**2+(p.y-my)**2;if(d<r*r&&d<bd){bd=d;b=g}}return b}
function tipHTML(n){const top=axes.map(a=>({a,s:n.sc[a.key],note:n.notes[a.key]})).filter(x=>x.note).sort((x,y)=>Math.abs(y.s-50)-Math.abs(x.s-50)).slice(0,4);return'<div class="t">'+esc(n.t)+'</div><div class="co">'+esc(n.core)+'</div><div class="f">hub '+n.hub+' · '+top.map(x=>esc(x.a.name)+' '+x.s).join(' · ')+'</div>'}
function showDetail(n){focus=n;detailEl.classList.add('on');
  const reg=(clusters.find(c=>c.c===n.cl)||{}).label||'';
  const meta=[n.author,n.date?new Date(n.date).toISOString().slice(0,10):'',reg].filter(Boolean).map(esc).join(' · ');
  const open=n.url?'<a class="open" href="'+esc(n.url)+'" target="_blank" rel="noopener">open source →</a>':'';
  const prof=axes.map(a=>({a,s:n.sc[a.key],note:n.notes[a.key]})).filter(x=>x.note).sort((x,y)=>Math.abs(y.s-50)-Math.abs(x.s-50)).slice(0,6).map(x=>'<div class="ax" title="'+esc(x.s>=50?x.a.high:x.a.low)+' — '+esc(x.note)+'"><span class="axn">'+esc(x.a.name)+'</span><span class="axs">'+(x.s>=50?'▲':'▼')+' <b>'+x.s+'</b></span></div>').join('');
  detailEl.innerHTML='<div class="x" onclick="clearFocus()">✕</div><div class="t">'+esc(n.t)+'</div>'+(meta?'<div class="meta">'+meta+'</div>':'')+open+'<div class="co">'+esc(n.core)+'</div><h4>where it sits</h4>'+(prof||'<div class="meta">—</div>')+'<h4>nearest '+n.nbr.length+'</h4>'+n.nbr.map(j=>'<div class="nb" onclick="focusIdx('+j+')">→ '+esc(nodes[j].t)+'</div>').join('');draw()}
window.clearFocus=()=>{focus=null;detailEl.classList.remove('on');draw()};window.focusIdx=j=>showDetail(nodes[j]);
let drag=null;cv.addEventListener('mousedown',e=>{drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,ry:rotY,rx:rotX,m:0};cv.classList.add('drag')});
addEventListener('mouseup',e=>{if(drag&&drag.m<4){const g=pickG(e.clientX,e.clientY);if(g){window.open(g.url,'_blank')}else{const n=pick(e.clientX,e.clientY);if(n)showDetail(n);else clearFocus()}}drag=null;cv.classList.remove('drag')});
addEventListener('mousemove',e=>{if(drag){drag.m+=Math.abs(e.movementX)+Math.abs(e.movementY);if(layout==='orbit'){rotY=drag.ry+(e.clientX-drag.x)*.008;rotX=drag.rx+(e.clientY-drag.y)*.008;relayout()}else{view.x=drag.vx+e.clientX-drag.x;view.y=drag.vy+e.clientY-drag.y;draw()}return}const g=pickG(e.clientX,e.clientY);const n=g?null:pick(e.clientX,e.clientY);if(g!==ghover){ghover=g;draw()}if(n!==hover){hover=n;draw();if(n)tip.innerHTML=tipHTML(n)}if(g)tip.innerHTML='<div class="t">'+esc(g.title)+'</div><div class="co">'+esc(g.core)+'</div><div class="f">cited by '+g.n+' of your papers · click → arxiv</div>';if(g||n){tip.style.opacity=1;tip.style.left=Math.min(e.clientX+14,W-tip.offsetWidth-8)+'px';tip.style.top=Math.min(e.clientY+14,H-tip.offsetHeight-8)+'px'}else tip.style.opacity=0});
cv.addEventListener('wheel',e=>{e.preventDefault();const f=Math.exp(-e.deltaY*.0015),ns=Math.max(.4,Math.min(22,view.s*f));const wx=(e.clientX-W/2-view.x)/view.s,wy=(e.clientY-H/2-view.y)/view.s;view.s=ns;view.x=e.clientX-W/2-wx*ns;view.y=e.clientY-H/2-wy*ns;draw()},{passive:false});
function esc(s){return(s||'').toString().replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
const axl=a=>(a.weak?'~ ':'')+a.name;const xax=document.getElementById('xax'),yax=document.getElementById('yax');axes.forEach(a=>{xax.add(new Option(axl(a),a.key));yax.add(new Option(axl(a),a.key))});xax.value=xKey;yax.value=yKey;
const lsel=document.getElementById('layout');function syncXY(){const on=layout==='axes';document.getElementById('xrow').classList.toggle('on',on);document.getElementById('yrow').classList.toggle('on',on)}
lsel.onchange=e=>{layout=e.target.value;syncXY();relayout()};xax.onchange=e=>{xKey=e.target.value;relayout()};yax.onchange=e=>{yKey=e.target.value;relayout()};
const csel=document.getElementById('color');csel.add(new Option('region','cluster'));axes.forEach(a=>csel.add(new Option('axis: '+axl(a),a.key)));csel.value='cluster';csel.onchange=e=>{color=e.target.value;buildLegend();draw()};
const ssel=document.getElementById('size');ssel.add(new Option('uniform','uniform'));ssel.add(new Option('influence (hub)','hub'));axes.forEach(a=>ssel.add(new Option('commit: '+a.name,a.key)));ssel.value='hub';ssel.onchange=e=>{sizeBy=e.target.value;draw()};
function buildLegend(){const L=document.getElementById('legend');let h='';if(color==='cluster'){h='<div style="font-family:var(--mono);font-size:10px;color:var(--soft);margin-bottom:5px">'+k+' REGIONS · hover to isolate</div>';for(const c of clusters)h+='<div class="r" data-cl="'+c.c+'"><span class="sw" style="background:hsl('+HUES[c.c%HUES.length]+' 62% 60%)"></span><span>'+esc(c.label)+' <span style="color:var(--soft)">'+c.n+'</span></span></div>'}else{const a=AX[color];h='<div style="font-family:var(--mono);font-size:10px;color:var(--soft);margin-bottom:5px">'+esc(a.name.toUpperCase())+'</div><div class="r"><span class="sw" style="background:hsl(250 74% 40%)"></span>'+esc(a.low)+'</div><div class="r"><span class="sw" style="background:hsl(0 74% 60%)"></span>'+esc(a.high)+'</div>'}L.innerHTML=h;L.querySelectorAll('[data-cl]').forEach(el=>{el.onmouseenter=()=>{hlCluster=+el.dataset.cl;draw()};el.onmouseleave=()=>{hlCluster=null;draw()}})}
document.getElementById('q').oninput=()=>draw();document.getElementById('labels').onclick=e=>{showLabels=!showLabels;e.target.classList.toggle('on',showLabels);draw()};
document.getElementById('reset').onclick=()=>{view={s:1,x:0,y:0};rotY=.5;rotX=-.3;clearFocus();relayout()};document.getElementById('theme').onclick=()=>{const r=document.documentElement;r.setAttribute('data-theme',r.getAttribute('data-theme')==='light'?'dark':'light');draw()};
const fb=document.getElementById('frontbtn');if(fb)fb.onclick=e=>{frontierOn=!frontierOn;e.target.classList.toggle('on',frontierOn);draw()};const cb=document.getElementById('citebtn');if(cb)cb.onclick=e=>{citeOn=!citeOn;e.target.classList.toggle('on',citeOn);draw()};
addEventListener('resize',()=>{DPR=Math.min(2,devicePixelRatio||1);W=innerWidth;H=innerHeight;cv.width=W*DPR;cv.height=H*DPR;draw()});
// deck-view: a READER, not a wall. title + core + region + the 3 strongest axis placements.
// sort by influence or any axis (sorting by an axis makes it a readable spectrum). filterable.
let deckSort='hub',deckQ='';
const regOf=n=>clusters.find(c=>c.c===n.cl)?.label||'region';
function chip(n,a,forceHi){const s=Math.round(n.sc[a.key]||50);const hi=forceHi||Math.abs(s-50)>22;const dir=s>=50?'▲':'▼';return '<span class="chip'+(hi?' hi':'')+'">'+esc(a.name.split(/ vs\.? | and /i)[0].slice(0,16))+' '+s+dir+'</span>';}
function buildDeck(){const el=document.getElementById('deck');const opts=['hub',...axes.map(a=>a.key)];
  let list=nodes.slice();
  if(deckQ)list=list.filter(n=>n.t.toLowerCase().includes(deckQ)||n.core.toLowerCase().includes(deckQ));
  list.sort((a,b)=>deckSort==='hub'?b.hub-a.hub:(b.sc[deckSort]||0)-(a.sc[deckSort]||0));
  el.innerHTML='<div class="top"><b style="font-size:13px">Deck</b><span style="font-family:var(--mono);font-size:10px;color:var(--soft)">'+list.length+' cards · sort</span>'+
    '<select id="dsort" style="flex:0 0 auto;width:190px">'+opts.map(o=>'<option value="'+o+'"'+(o===deckSort?' selected':'')+'>'+(o==='hub'?'influence':esc(AX[o].name))+'</option>').join('')+'</select>'+
    '<input id="dq" placeholder="filter…" value="'+esc(deckQ)+'" style="flex:1;min-width:70px"><span class="x" onclick="toggleDeck()">✕</span></div>'+
    '<div class="list">'+list.slice(0,300).map(n=>{
      const top=axes.map(a=>({a,d:Math.abs((n.sc[a.key]||50)-50)})).sort((x,y)=>y.d-x.d).slice(0,3);
      const chips=(deckSort!=='hub'?chip(n,AX[deckSort],true):'')+top.filter(t=>deckSort==='hub'||t.a.key!==deckSort).slice(0,3).map(t=>chip(n,t.a)).join('');
      return '<div class="card" onclick="focusIdx('+n.i+');toggleDeck()"><div class="ct">'+esc(n.t)+'</div><div class="cc">'+esc(n.core.slice(0,180))+'</div><div class="chips"><span class="chip reg">◆ '+esc(regOf(n))+'</span>'+chips+'</div></div>';
    }).join('')+'</div>';
  document.getElementById('dsort').onchange=e=>{deckSort=e.target.value;buildDeck();};
  const dq=document.getElementById('dq');dq.oninput=()=>{deckQ=dq.value.toLowerCase();buildDeck();};dq.focus();dq.setSelectionRange(dq.value.length,dq.value.length);}
window.toggleDeck=()=>{const el=document.getElementById('deck'),on=!el.classList.contains('on');el.classList.toggle('on',on);document.getElementById('deckbtn').classList.toggle('on',on);if(on)buildDeck();};
document.getElementById('deckbtn').onclick=()=>window.toggleDeck();
W=innerWidth;H=innerHeight;cv.width=W*DPR;cv.height=H*DPR;buildLegend();syncXY();draw();
</script>`;
}

if (import.meta.main) {
  const D = JSON.parse(readFileSync("/Users/deepfates/Hacking/readwise/triangulation/runs/main/mde-data.json", "utf8"));
  const html = renderHTML(D);
  writeFileSync("eidoscope-fixture.html", html);
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  try { new Function(script); console.log(`✅ viewer renders — ${(html.length / 1024).toFixed(0)}KB, script parses clean`); }
  catch (e: any) { console.log("⚠ syntax error:", e.message); }
}
