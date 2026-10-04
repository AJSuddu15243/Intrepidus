import { join } from 'node:path';
import { atomicWrite } from './profiles.ts';
import { type Memory } from './memory.ts';

export function exportBrowser(memory: Memory, profile: string, directory = memory.directory) {
  const data = JSON.stringify({ profile, root: memory.root, tree: [...memory.tree.values()], view: memory.view }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>OptChat memory</title>
<style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;background:#f6f5f1;color:#20231e}h1{font-size:32px}details{margin:8px 0;padding:12px;border:1px solid #d8dbd0;border-radius:8px;background:white}summary{cursor:pointer;white-space:pre-wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px ui-monospace,monospace}small{color:#647057}button{padding:10px;margin:8px 8px 8px 0;cursor:pointer}</style>
<h1 id="title"></h1><p id="info"></p><button id="view">Current view</button><button id="all">All original messages</button><label>Tree level <select id="level"><option value="">Choose…</option></select></label><main id="memory"></main>
<script type="application/json" id="data">${data}</script><script>
const d=JSON.parse(document.getElementById('data').textContent), nodes=new Map(d.tree.map(n=>[n.l+':'+n.i,n]));
document.getElementById('title').textContent='OptChat · '+d.profile;
document.getElementById('info').textContent=d.root.length+' messages · '+d.tree.length+' summaries · Snapshot '+new Date().toLocaleString()+'. Open a line to zoom.';
const main=document.getElementById('memory');
function raw(i){const r=d.root[i],p=document.createElement('pre');p.textContent=r? r.i+' · '+r.date+' · '+r.kind+'\\n\\n'+r.text:'Message unavailable';return p;}
function node(l,i){const first=i*2**l,n=nodes.get(l+':'+i),el=document.createElement('details'),s=document.createElement('summary'),meta=document.createElement('small');s.textContent=first+'+'+2**l+' | '+(n?n.text:'Not summarized yet');meta.textContent=(n?n.size+' bytes · ':'')+(d.root[first]?.date||'')+' — '+(d.root[first+2**l-1]?.date||'');el.append(s,meta);let built=false;el.addEventListener('toggle',()=>{if(!el.open||built)return;built=true;if(l===0)el.append(raw(i));else el.append(node(l-1,i*2),node(l-1,i*2+1));});return el;}
function view(){main.replaceChildren(...d.view.map(p=>node(p.l,p.i)));}
document.getElementById('view').onclick=view;document.getElementById('all').onclick=()=>main.replaceChildren(...d.root.map(r=>{const e=document.createElement('details'),s=document.createElement('summary');s.textContent=r.i+' · '+r.date+' · '+r.kind+' · '+r.size+' bytes';e.append(s);e.addEventListener('toggle',()=>{if(e.open&&e.children.length===1)e.append(raw(r.i));});return e;}));
const levels=document.getElementById('level');for(const l of [...new Set(d.tree.map(n=>n.l))].sort((a,b)=>b-a)){const o=document.createElement('option');o.value=l;o.textContent='Level '+l+' ('+2**l+' messages/node)';levels.append(o);}levels.onchange=()=>{if(levels.value!=='')main.replaceChildren(...d.tree.filter(n=>n.l===Number(levels.value)).sort((a,b)=>a.i-b.i).map(n=>node(n.l,n.i)));};view();
</script></html>`;
  const path = join(directory, 'memory.html'); atomicWrite(path, html); return path;
}
