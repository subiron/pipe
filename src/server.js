const express = require('express');
const multer = require('multer');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const upload = multer({ dest: 'uploads/' });
const LIBRARY_PATH    = path.join(__dirname, '../data/library.json');
const WORKSPACES_PATH = path.join(__dirname, '../data/workspaces.json');

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

/* ── helpers ─────────────────────────────────── */
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

/* ── Library ─────────────────────────────────── */
app.get('/library', (_, res) => res.json(readJSON(LIBRARY_PATH, [])));

app.post('/library', (req, res) => {
  const { name, code, category, description } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const lib = readJSON(LIBRARY_PATH, []);
  const entry = { id: 'user-' + Date.now(), name, category: category || 'Custom', description: description || '', code };
  lib.push(entry);
  writeJSON(LIBRARY_PATH, lib);
  res.json(entry);
});

app.put('/library/:id', (req, res) => {
  const lib = readJSON(LIBRARY_PATH, []);
  const idx = lib.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  lib[idx] = { ...lib[idx], ...req.body, id: lib[idx].id };
  writeJSON(LIBRARY_PATH, lib);
  res.json(lib[idx]);
});

app.delete('/library/:id', (req, res) => {
  const lib = readJSON(LIBRARY_PATH, []);
  const idx = lib.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  lib.splice(idx, 1);
  writeJSON(LIBRARY_PATH, lib);
  res.json({ ok: true });
});

/* ── Workspaces ──────────────────────────────── */
app.get('/workspaces', (_, res) => res.json(readJSON(WORKSPACES_PATH, [])));

app.post('/workspaces', (req, res) => {
  const { name, nodes } = req.body;
  if (!name || !Array.isArray(nodes)) return res.status(400).json({ error: 'name and nodes required' });
  const workspaces = readJSON(WORKSPACES_PATH, []);
  const entry = {
    id: 'ws-' + Date.now(),
    name: name.trim(),
    nodes: nodes.map(n => ({ name: n.name, code: n.code })),
    savedAt: new Date().toISOString(),
  };
  workspaces.unshift(entry);          // newest first
  writeJSON(WORKSPACES_PATH, workspaces);
  res.json(entry);
});

app.delete('/workspaces/:id', (req, res) => {
  const workspaces = readJSON(WORKSPACES_PATH, []);
  const idx = workspaces.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  workspaces.splice(idx, 1);
  writeJSON(WORKSPACES_PATH, workspaces);
  res.json({ ok: true });
});

/* ── File processing ─────────────────────────── */
async function processFile(filePath, nodes, ws) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let lineNumber = 0, processedCount = 0, errorCount = 0;
  const results = [];
  const nodeContexts = nodes.map(() => ({}));

  for await (const line of rl) {
    lineNumber++;
    let value = line, skipped = false;
    const lineTrace = [];

    for (let i = 0; i < nodes.length; i++) {
      if (skipped) break;
      const node = nodes[i], ctx = nodeContexts[i];
      try {
        const fn = new Function('line', 'lineNumber', `"use strict";\n${node.code}`);
        const result = fn.call(ctx, value, lineNumber);
        if (result === null || result === undefined) {
          skipped = true;
          lineTrace.push({ nodeId: node.id, nodeName: node.name, input: value, output: null, skipped: true });
        } else {
          lineTrace.push({ nodeId: node.id, nodeName: node.name, input: value, output: String(result) });
          value = String(result);
        }
      } catch (err) {
        lineTrace.push({ nodeId: node.id, nodeName: node.name, input: value, output: null, error: err.message });
        skipped = true; errorCount++; break;
      }
    }

    if (!skipped) { processedCount++; results.push(value); }

    if (lineNumber % 100 === 0 || lineNumber <= 50) {
      ws.send(JSON.stringify({ type: 'progress', lineNumber, processedCount, errorCount }));
    }
  }

  ws.send(JSON.stringify({ type: 'complete', totalLines: lineNumber, processedCount, errorCount, results: results.slice(0, 1000) }));
  fs.writeFileSync(filePath + '.output.txt', results.join('\n'));
}

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ fileId: req.file.filename, originalName: req.file.originalname, size: req.file.size });
});

// GET /random-line/:fileId
// Optional body (POST): { nodes: [{code},...] } — pipeline to run the line through before returning
app.get('/random-line/:fileId', async (req, res) => {
  const filePath = path.join('uploads', req.params.fileId);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let chosen = '', count = 0;
  for await (const line of rl) {
    if (line.trim()) { count++; if (Math.random() < 1 / count) chosen = line; }
  }
  res.json({ line: chosen });
});

// POST /sample-line/:fileId  — random line passed through given nodes (for test-input pre-fill)
app.post('/sample-line/:fileId', async (req, res) => {
  const filePath = path.join('uploads', req.params.fileId);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const nodes = Array.isArray(req.body.nodes) ? req.body.nodes : [];

  // Reservoir-sample a random non-empty line
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let chosen = '', count = 0;
  for await (const line of rl) {
    if (line.trim()) { count++; if (Math.random() < 1 / count) chosen = line; }
  }

  if (!nodes.length) return res.json({ line: chosen, dropped: false });

  // Run the line through each node in order
  let value = chosen;
  const ctx = {};
  for (let i = 0; i < nodes.length; i++) {
    try {
      const fn = new Function('line', 'lineNumber', `"use strict";\n${nodes[i].code}`);
      const result = fn.call(ctx, value, 1);
      if (result === null || result === undefined) {
        return res.json({ line: null, dropped: true, droppedAt: i });
      }
      value = String(result);
    } catch (err) {
      return res.json({ line: null, dropped: true, droppedAt: i, error: err.message });
    }
  }

  res.json({ line: value, dropped: false });
});

app.get('/download/:fileId', (req, res) => {
  const out = path.join('uploads', req.params.fileId + '.output.txt');
  if (!fs.existsSync(out)) return res.status(404).json({ error: 'Output not found' });
  res.download(out, 'output.txt');
});

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'process') {
        const filePath = path.join('uploads', msg.fileId);
        if (!fs.existsSync(filePath)) { ws.send(JSON.stringify({ type: 'error', message: 'File not found' })); return; }
        await processFile(filePath, msg.nodes, ws);
      }
    } catch (err) { ws.send(JSON.stringify({ type: 'error', message: err.message })); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PIPE running on http://localhost:${PORT}`));
