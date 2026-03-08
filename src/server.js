const express  = require('express');
const multer   = require('multer');
const http     = require('http');
const WebSocket= require('ws');
const path     = require('path');
const fs       = require('fs');
const readline = require('readline');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const upload = multer({ dest: 'uploads/' });

const LIBRARY_PATH    = path.join(__dirname, '../data/library.json');
const WORKSPACES_PATH = path.join(__dirname, '../data/workspaces.json');

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

/* ── helpers ─────────────────────────────────── */
const readJSON  = (p, fb) => { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return fb; } };
const writeJSON = (p, d)  => fs.writeFileSync(p, JSON.stringify(d, null, 2));

/* ── Library ─────────────────────────────────── */
app.get('/library', (_,res) => res.json(readJSON(LIBRARY_PATH,[])));
app.post('/library', (req,res) => {
  const { name, code, category, description } = req.body;
  if (!name||!code) return res.status(400).json({error:'name and code required'});
  const lib = readJSON(LIBRARY_PATH,[]);
  const entry = { id:'user-'+Date.now(), name, category:category||'Custom', description:description||'', code };
  lib.push(entry); writeJSON(LIBRARY_PATH,lib); res.json(entry);
});
app.delete('/library/:id', (req,res) => {
  const lib = readJSON(LIBRARY_PATH,[]);
  const i = lib.findIndex(n=>n.id===req.params.id);
  if (i===-1) return res.status(404).json({error:'Not found'});
  lib.splice(i,1); writeJSON(LIBRARY_PATH,lib); res.json({ok:true});
});

/* ── Workspaces ──────────────────────────────── */
app.get('/workspaces', (_,res) => res.json(readJSON(WORKSPACES_PATH,[])));
app.post('/workspaces', (req,res) => {
  const { name, graph } = req.body;
  if (!name||!graph) return res.status(400).json({error:'name and graph required'});
  const ws = readJSON(WORKSPACES_PATH,[]);
  const entry = { id:'ws-'+Date.now(), name:name.trim(), graph, savedAt:new Date().toISOString() };
  ws.unshift(entry); writeJSON(WORKSPACES_PATH,ws); res.json(entry);
});
app.delete('/workspaces/:id', (req,res) => {
  const ws = readJSON(WORKSPACES_PATH,[]);
  const i  = ws.findIndex(w=>w.id===req.params.id);
  if (i===-1) return res.status(404).json({error:'Not found'});
  ws.splice(i,1); writeJSON(WORKSPACES_PATH,ws); res.json({ok:true});
});

/* ── File upload ─────────────────────────────── */
app.post('/upload', upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({error:'No file'});
  res.json({ fileId:req.file.filename, originalName:req.file.originalname, size:req.file.size });
});

/* ── Random / sample line ────────────────────── */
async function reservoirLine(filePath) {
  const rl = readline.createInterface({ input:fs.createReadStream(filePath), crlfDelay:Infinity });
  let chosen='', count=0;
  for await (const line of rl) {
    if (line.trim()) { count++; if (Math.random()<1/count) chosen=line; }
  }
  return chosen;
}

app.get('/random-line/:fileId', async (req,res) => {
  const fp = path.join('uploads', req.params.fileId);
  if (!fs.existsSync(fp)) return res.status(404).json({error:'Not found'});
  res.json({ line: await reservoirLine(fp) });
});

app.post('/sample-line/:fileId', async (req,res) => {
  const nodes = Array.isArray(req.body.nodes) ? req.body.nodes : [];

  // Special case: line passed directly (used by generator test sampling)
  if (req.params.fileId === '__generator__') {
    const raw = req.body.line;
    if (!raw || !nodes.length) return res.json({ line: raw || null, dropped: !raw });
    let value = raw;
    const ctx = {};
    for (let i = 0; i < nodes.length; i++) {
      try {
        const fn = new Function('line','lineNumber',`"use strict";\n${nodes[i].code}`);
        const r  = fn.call(ctx, value, 1);
        if (r === null || r === undefined) return res.json({ line: null, dropped: true, droppedAt: i });
        value = String(r);
      } catch(err) { return res.json({ line: null, dropped: true, droppedAt: i, error: err.message }); }
    }
    return res.json({ line: value, dropped: false });
  }

  const fp = path.join('uploads', req.params.fileId);
  if (!fs.existsSync(fp)) return res.status(404).json({error:'Not found'});
  const raw = await reservoirLine(fp);
  if (!nodes.length) return res.json({ line:raw, dropped:false });
  let value = raw;
  const ctx = {};
  for (let i=0; i<nodes.length; i++) {
    try {
      const fn = new Function('line','lineNumber',`"use strict";\n${nodes[i].code}`);
      const r  = fn.call(ctx, value, 1);
      if (r===null||r===undefined) return res.json({ line:null, dropped:true, droppedAt:i });
      value = String(r);
    } catch(err) { return res.json({ line:null, dropped:true, droppedAt:i, error:err.message }); }
  }
  res.json({ line:value, dropped:false });
});

/* ── Download ────────────────────────────────── */
app.get('/download/:fileId', (req,res) => {
  const out = path.join('uploads', req.params.fileId+'.output.txt');
  if (!fs.existsSync(out)) return res.status(404).json({error:'Not found'});
  res.download(out, 'output.txt');
});

/* ── Generator sample (first few lines) ─────── */
app.post('/generator-sample', (req, res) => {
  const { code, count = 5 } = req.body;
  if (!code) return res.json({ lines: [] });
  try {
    const iter = new Function(`"use strict";\nreturn (function*() {\n${code}\n})();`)();
    const lines = [];
    for (const val of iter) {
      lines.push(String(val));
      if (lines.length >= count) break;
    }
    res.json({ lines });
  } catch(err) {
    res.json({ lines: [], error: err.message });
  }
});

/* ── File exists check ───────────────────────── */
app.get('/file-exists/:fileId', (req,res) => {
  const fp = path.join('uploads', req.params.fileId);
  res.json({ exists: fs.existsSync(fp) });
});

/* ════════════════════════════════════════════════
   GRAPH EXECUTOR
   Processes file line-by-line through a DAG of nodes.
   Each line produces one value per node (or null=dropped).
   END node collects all values sent to it.
   ════════════════════════════════════════════════ */

function topoSort(nodes, edges) {
  const inDeg = {};
  nodes.forEach(n => { inDeg[n.id] = 0; });
  edges.forEach(e => { inDeg[e.toNode] = (inDeg[e.toNode]||0)+1; });
  const queue = nodes.filter(n=>inDeg[n.id]===0).map(n=>n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift(); order.push(id);
    edges.filter(e=>e.fromNode===id).forEach(e=>{
      inDeg[e.toNode]--; if (inDeg[e.toNode]===0) queue.push(e.toNode);
    });
  }
  return order;
}

function toVarName(name) {
  return name.replace(/[^a-zA-Z0-9_$]/g,'_').replace(/^[0-9]/,'_$&') || 'input';
}

function getInputVarNames(nodeId, nodes, edges) {
  const incoming = edges.filter(e=>e.toNode===nodeId);
  const raw = incoming.map(e => {
    const src = nodes.find(n=>n.id===e.fromNode);
    return src ? toVarName(src.name) : 'input';
  });
  const counts = {}; raw.forEach(n=>{ counts[n]=(counts[n]||0)+1; });
  const seen = {};
  return raw.map(n => {
    if (counts[n]===1) return n;
    seen[n]=(seen[n]||0)+1; return n+'_'+seen[n];
  });
}

async function processGraph(nodes, edges, ws) {
  const sourceNodes    = nodes.filter(n => n.isSource);
  const generatorNodes = nodes.filter(n => n.isGenerator);
  const endNode        = nodes.find(n => n.isEnd);

  if (!endNode) {
    ws.send(JSON.stringify({ type:'error', message:'Graph needs an END node' })); return;
  }
  if (!sourceNodes.length && !generatorNodes.length) {
    ws.send(JSON.stringify({ type:'error', message:'Graph needs at least one SOURCE or GENERATOR node' })); return;
  }

  // Validate source files
  for (const src of sourceNodes) {
    const fp = path.join('uploads', src.fileId || '');
    if (!src.fileId || !fs.existsSync(fp)) {
      ws.send(JSON.stringify({ type:'error', message:`Source "${src.name}" has no file loaded` })); return;
    }
  }

  // Pre-compile generator functions (must be generator functions using yield)
  const genFns = {};
  for (const node of generatorNodes) {
    try {
      genFns[node.id] = new Function(`"use strict";\nreturn (function*() {\n${node.code}\n})();`);
    } catch(err) {
      ws.send(JSON.stringify({ type:'error', message:`Syntax error in generator "${node.name}": ${err.message}` })); return;
    }
  }

  // Pre-compile regular node functions
  const fns = {};
  for (const node of nodes) {
    if (node.isSource || node.isEnd || node.isGenerator) continue;
    try {
      const varNames = getInputVarNames(node.id, nodes, edges);
      const args = varNames.length ? [...varNames,'lineNumber'] : ['line','lineNumber'];
      fns[node.id] = { fn: new Function(...args, `"use strict";\n${node.code}`), varNames };
    } catch(err) {
      ws.send(JSON.stringify({ type:'error', message:`Syntax error in "${node.name}": ${err.message}` })); return;
    }
  }

  const ctxs = {};
  nodes.forEach(n => { ctxs[n.id] = {}; });

  let totalLines = 0, processedCount = 0, errorCount = 0;
  const results = [];

  // Helper: process a single "root" node (source or generator) through its subgraph
  async function processSubgraph(rootNodeId, lineIterator) {
    const reachable = new Set();
    const stack = [rootNodeId];
    while (stack.length) {
      const cur = stack.pop();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      edges.filter(e => e.fromNode === cur).forEach(e => stack.push(e.toNode));
    }
    const subNodes = nodes.filter(n => reachable.has(n.id));
    const order    = topoSort(subNodes, edges.filter(e => reachable.has(e.fromNode) && reachable.has(e.toNode)));
    let lineNumber = 0;

    for await (const rawLine of lineIterator) {
      lineNumber++; totalLines++;
      const values = { [rootNodeId]: rawLine };

      for (const nodeId of order) {
        const node = subNodes.find(n => n.id === nodeId);
        if (!node || node.isSource || node.isGenerator) continue;
        if (node.isEnd) {
          const incoming = edges.filter(e => e.toNode === nodeId && reachable.has(e.fromNode));
          for (const edge of incoming) {
            const v = values[edge.fromNode];
            if (v !== null && v !== undefined) { results.push(String(v)); processedCount++; }
          }
          continue;
        }
        const incoming = edges.filter(e => e.toNode === nodeId && reachable.has(e.fromNode));
        if (!incoming.length) continue;
        const inputVals = incoming.map(e => values[e.fromNode]);
        if (inputVals.every(v => v === null || v === undefined)) { values[nodeId] = null; continue; }
        const compiled = fns[nodeId];
        if (!compiled) continue;
        try {
          const argValues = compiled.varNames.length
            ? [...compiled.varNames.map((_, i) => inputVals[i] ?? ''), lineNumber]
            : [inputVals[0] ?? '', lineNumber];
          const result = compiled.fn.call(ctxs[nodeId], ...argValues);
          values[nodeId] = (result === null || result === undefined) ? null : String(result);
        } catch { values[nodeId] = null; errorCount++; }
      }

      if (totalLines % 200 === 0) {
        ws.send(JSON.stringify({ type:'progress', lineNumber: totalLines, processedCount, errorCount }));
      }
    }
  }

  // Process FILE sources
  for (const srcNode of sourceNodes) {
    const filePath = path.join('uploads', srcNode.fileId);
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    await processSubgraph(srcNode.id, rl);
  }

  // Process GENERATOR nodes
  for (const genNode of generatorNodes) {
    async function* genIterator() {
      const iter = genFns[genNode.id]();
      for (const val of iter) yield String(val);
    }
    await processSubgraph(genNode.id, genIterator());
  }

  // Write output
  const firstRootId = (sourceNodes[0] || generatorNodes[0])?.fileId || ('gen-' + Date.now());
  const outputPath = path.join('uploads', (sourceNodes[0]?.fileId || 'generator') + '.output.txt');
  fs.writeFileSync(outputPath, results.join('\n'));
  ws.send(JSON.stringify({ type:'complete', totalLines, processedCount, errorCount, results: results.slice(0, 1000) }));
}

/* ── WebSocket ───────────────────────────────── */
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'process') {
        await processGraph(msg.nodes, msg.edges, ws);
      }
    } catch(err) { ws.send(JSON.stringify({ type:'error', message: err.message })); }
  });
});

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>console.log(`PIPE running on http://localhost:${PORT}`));
