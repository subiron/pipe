/* ═══════════════════════════════════════════════
   PIPE — Application Logic
   ═══════════════════════════════════════════════ */

const state = {
  fileId: null, fileName: null,
  nodes: [], editingNodeId: null,
  ws: null, processing: false,
  lastOutputFileId: null, totalLines: 0,
  library: [], libraryFilter: 'All', librarySearch: '',
  workspaces: [],
};

let nodeIdCounter = 0;

/* ── WEBSOCKET ───────────────────────────────── */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.onopen  = () => console.log('[WS] connected');
  state.ws.onclose = () => setTimeout(connectWS, 2000);
  state.ws.onerror = (e) => console.error('[WS]', e);
  state.ws.onmessage = (evt) => handleWSMessage(JSON.parse(evt.data));
}
function handleWSMessage(msg) {
  if (msg.type === 'progress') updateProgress(msg);
  else if (msg.type === 'complete') onProcessingComplete(msg);
  else if (msg.type === 'error') onProcessingError(msg.message);
}

/* ── FILE UPLOAD ─────────────────────────────── */
const dropzone      = document.getElementById('dropzone');
const fileInput     = document.getElementById('file-input');
const fileInfo      = document.getElementById('file-info');
const dropzoneInner = dropzone.querySelector('.dropzone-inner');

dropzone.addEventListener('click', (e) => {
  if (!e.target.closest('.file-remove') && !e.target.closest('.file-info')) fileInput.click();
});
dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
document.getElementById('file-remove').addEventListener('click', (e) => { e.stopPropagation(); clearFile(); });

function clearFile() {
  state.fileId = null; state.fileName = null;
  fileInput.value = ''; fileInfo.hidden = true;
  dropzoneInner.style.display = '';
  updateRunButton(); clearOutput();
}

async function uploadFile(file) {
  const fd = new FormData(); fd.append('file', file);
  dropzoneInner.style.display = 'none'; fileInfo.hidden = false;
  document.getElementById('file-name').textContent = file.name;
  document.getElementById('file-meta').textContent = 'Uploading...';
  try {
    const data = await fetch('/upload', { method: 'POST', body: fd }).then(r => r.json());
    state.fileId = data.fileId; state.fileName = data.originalName;
    document.getElementById('file-name').textContent = data.originalName;
    document.getElementById('file-meta').textContent = formatBytes(data.size);
    updateRunButton();
  } catch { document.getElementById('file-meta').textContent = 'Upload failed'; }
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

/* ── NODE MANAGEMENT ─────────────────────────── */
const nodesList    = document.getElementById('nodes-list');
const pipelineEmpty = document.getElementById('pipeline-empty');

function createNode(name = 'Transform', code = 'return line.trim();') {
  return { id: ++nodeIdCounter, name, code };
}
function deleteNode(id) {
  state.nodes = state.nodes.filter(n => n.id !== id);
  renderNodes(); updateRunButton();
}
function renderNodes() {
  nodesList.innerHTML = '';
  if (!state.nodes.length) { pipelineEmpty.style.display = ''; return; }
  pipelineEmpty.style.display = 'none';
  state.nodes.forEach((node, idx) => {
    if (idx > 0) {
      const c = document.createElement('div');
      c.className = 'pipeline-connector'; c.textContent = '│'; nodesList.appendChild(c);
    }
    nodesList.appendChild(createNodeCard(node, idx + 1));
  });
  updateRunButton();
}
function createNodeCard(node, index) {
  const card = document.createElement('div');
  card.className = 'node-card'; card.dataset.id = node.id; card.draggable = true;
  const preview = node.code.split('\n').find(l => l.trim() && !l.trim().startsWith('//')) || '';
  card.innerHTML = `
    <div class="node-header">
      <div class="node-drag-handle">⠿</div>
      <div class="node-index">${String(index).padStart(2,'0')}</div>
      <div class="node-name">${esc(node.name)}</div>
      <div class="node-actions">
        <button class="node-btn edit">edit</button>
        <button class="node-btn delete">✕</button>
      </div>
    </div>
    <div class="node-preview">${esc(preview.trim().substring(0,80))}</div>`;
  card.querySelector('.node-btn.edit').addEventListener('click', () => openEditor(node.id));
  card.querySelector('.node-btn.delete').addEventListener('click', () => deleteNode(node.id));
  setupNodeDrag(card, node.id);
  return card;
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ── DRAG REORDER ────────────────────────────── */
let dragSrcId = null;
function setupNodeDrag(card, nodeId) {
  card.addEventListener('dragstart', (e) => { dragSrcId = nodeId; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  card.addEventListener('dragend',   ()  => { card.classList.remove('dragging'); document.querySelectorAll('.node-card').forEach(c => c.classList.remove('drag-target')); dragSrcId = null; });
  card.addEventListener('dragover',  (e) => { e.preventDefault(); if (dragSrcId !== nodeId) card.classList.add('drag-target'); });
  card.addEventListener('dragleave', ()  => card.classList.remove('drag-target'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSrcId || dragSrcId === nodeId) return;
    const si = state.nodes.findIndex(n => n.id === dragSrcId);
    const di = state.nodes.findIndex(n => n.id === nodeId);
    const [m] = state.nodes.splice(si, 1); state.nodes.splice(di, 0, m);
    renderNodes();
  });
}

/* ── LIBRARY ─────────────────────────────────── */
async function loadLibrary() {
  state.library = await fetch('/library').then(r => r.json());
}
function openLibrary() {
  state.libraryFilter = 'All'; state.librarySearch = '';
  document.getElementById('library-search').value = '';
  renderLibrary();
  document.getElementById('library-overlay').classList.remove('hidden');
}
function closeLibrary() { document.getElementById('library-overlay').classList.add('hidden'); }

function renderLibrary() {
  // categories
  const cats = ['All', ...new Set(state.library.map(n => n.category).filter(Boolean))];
  const catEl = document.getElementById('library-categories');
  catEl.innerHTML = '';
  cats.forEach(cat => {
    const b = document.createElement('button');
    b.className = 'cat-btn' + (state.libraryFilter === cat ? ' active' : '');
    b.textContent = cat;
    b.addEventListener('click', () => { state.libraryFilter = cat; renderLibrary(); });
    catEl.appendChild(b);
  });
  // grid
  const q = state.librarySearch.toLowerCase();
  const filtered = state.library.filter(n => {
    const mc = state.libraryFilter === 'All' || n.category === state.libraryFilter;
    const mq = !q || n.name.toLowerCase().includes(q) || (n.description||'').toLowerCase().includes(q);
    return mc && mq;
  });
  const grid = document.getElementById('library-grid');
  grid.innerHTML = '';
  if (!filtered.length) { grid.innerHTML = '<div class="lib-empty">No nodes found.</div>'; return; }
  filtered.forEach(entry => {
    const card = document.createElement('div'); card.className = 'lib-card';
    const isBuiltin = entry.id.startsWith('builtin-');
    card.innerHTML = `
      <div class="lib-card-cat cat-${entry.category}">${esc(entry.category)}</div>
      <div class="lib-card-name">${esc(entry.name)}</div>
      <div class="lib-card-desc">${esc(entry.description||'')}</div>
      ${!isBuiltin ? `<div class="lib-card-actions"><button class="lib-card-btn del-lib" data-id="${entry.id}">✕</button></div>` : ''}`;
    card.addEventListener('click', (e) => { if (!e.target.closest('.lib-card-btn')) addNodeFromLibrary(entry); });
    if (!isBuiltin) {
      card.querySelector('.del-lib').addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/library/${entry.id}`, { method: 'DELETE' });
        await loadLibrary(); renderLibrary();
      });
    }
    grid.appendChild(card);
  });
}
function addNodeFromLibrary(entry) {
  const node = createNode(entry.name, entry.code);
  state.nodes.push(node); renderNodes(); closeLibrary(); openEditor(node.id);
}
document.getElementById('library-search').addEventListener('input', (e) => { state.librarySearch = e.target.value; renderLibrary(); });
document.getElementById('library-close').addEventListener('click', closeLibrary);
document.getElementById('library-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('library-overlay')) closeLibrary(); });
document.getElementById('btn-new-from-scratch').addEventListener('click', () => {
  closeLibrary();
  const node = createNode(`Node ${state.nodes.length + 1}`);
  state.nodes.push(node); renderNodes(); openEditor(node.id);
});
document.getElementById('btn-add-node').addEventListener('click', openLibrary);

/* ── WORKSPACES ──────────────────────────────── */
async function loadWorkspaces() {
  state.workspaces = await fetch('/workspaces').then(r => r.json());
}

// ── Open workspace list modal
function openWorkspaces() {
  renderWorkspaceList();
  document.getElementById('ws-overlay').classList.remove('hidden');
}
function closeWorkspaces() { document.getElementById('ws-overlay').classList.add('hidden'); }

function renderWorkspaceList() {
  const list = document.getElementById('ws-list');
  list.innerHTML = '';

  if (!state.workspaces.length) {
    list.innerHTML = `
      <div class="ws-empty">
        <span class="ws-empty-icon">◫</span>
        No saved workspaces yet.<br>
        Build a pipeline and click <strong>Save Workspace</strong>.
      </div>`;
    return;
  }

  state.workspaces.forEach(ws => {
    const item = document.createElement('div'); item.className = 'ws-item';
    const date = new Date(ws.savedAt);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const pills = ws.nodes.slice(0, 5).map(n =>
      `<span class="ws-node-pill">${esc(n.name)}</span>`
    ).join('') + (ws.nodes.length > 5 ? `<span class="ws-node-pill">+${ws.nodes.length - 5} more</span>` : '');

    item.innerHTML = `
      <div class="ws-item-icon">◫</div>
      <div class="ws-item-info">
        <div class="ws-item-name">${esc(ws.name)}</div>
        <div class="ws-item-meta">${ws.nodes.length} node${ws.nodes.length !== 1 ? 's' : ''} · saved ${dateStr}</div>
        <div class="ws-item-nodes">${pills}</div>
      </div>
      <div class="ws-item-actions">
        <button class="ws-action-btn load">Load</button>
        <button class="ws-action-btn del">✕</button>
      </div>`;

    item.querySelector('.ws-action-btn.load').addEventListener('click', (e) => {
      e.stopPropagation(); loadWorkspace(ws);
    });
    item.querySelector('.ws-action-btn.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/workspaces/${ws.id}`, { method: 'DELETE' });
      await loadWorkspaces(); renderWorkspaceList();
    });
    // click row = load
    item.addEventListener('click', () => loadWorkspace(ws));
    list.appendChild(item);
  });
}

function loadWorkspace(ws) {
  state.nodes = ws.nodes.map(n => createNode(n.name, n.code));
  renderNodes(); closeWorkspaces();
  if (state.fileId && !state.processing) runPipeline();
}

// ── Open save-workspace modal
function openSaveWorkspace() {
  if (!state.nodes.length) {
    alert('Add some nodes to the pipeline before saving a workspace.');
    return;
  }
  const input = document.getElementById('ws-name-input');
  input.value = '';
  // preview pills
  const preview = document.getElementById('ws-save-preview');
  if (state.nodes.length) {
    preview.innerHTML = state.nodes.map(n => `<span class="ws-preview-pill">${esc(n.name)}</span>`).join('');
  } else {
    preview.innerHTML = '<span class="ws-preview-empty">No nodes in pipeline.</span>';
  }
  document.getElementById('ws-save-overlay').classList.remove('hidden');
  setTimeout(() => input.focus(), 80);
}
function closeSaveWorkspace() { document.getElementById('ws-save-overlay').classList.add('hidden'); }

async function confirmSaveWorkspace() {
  const name = document.getElementById('ws-name-input').value.trim();
  if (!name) { document.getElementById('ws-name-input').focus(); return; }
  await fetch('/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, nodes: state.nodes.map(n => ({ name: n.name, code: n.code })) }),
  });
  await loadWorkspaces();
  closeSaveWorkspace();
  // Flash the button
  const btn = document.getElementById('btn-save-workspace');
  const orig = btn.querySelector('span:last-child').textContent;
  btn.querySelector('span:last-child').textContent = 'Saved!';
  btn.style.borderColor = 'var(--ok)'; btn.style.color = 'var(--ok)';
  setTimeout(() => {
    btn.querySelector('span:last-child').textContent = orig;
    btn.style.borderColor = ''; btn.style.color = '';
  }, 2000);
}

document.getElementById('btn-workspaces').addEventListener('click', openWorkspaces);
document.getElementById('btn-save-workspace').addEventListener('click', openSaveWorkspace);
document.getElementById('ws-close').addEventListener('click', closeWorkspaces);
document.getElementById('ws-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('ws-overlay')) closeWorkspaces(); });
document.getElementById('ws-save-close').addEventListener('click', closeSaveWorkspace);
document.getElementById('ws-save-cancel').addEventListener('click', closeSaveWorkspace);
document.getElementById('ws-save-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('ws-save-overlay')) closeSaveWorkspace(); });
document.getElementById('ws-save-confirm').addEventListener('click', confirmSaveWorkspace);
document.getElementById('ws-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmSaveWorkspace(); });

/* ── SAVE TO LIBRARY ─────────────────────────── */
document.getElementById('btn-save-to-library').addEventListener('click', async () => {
  const name = document.getElementById('modal-node-name').value.trim() || 'Unnamed Node';
  const code = document.getElementById('modal-editor').value;
  const btn  = document.getElementById('btn-save-to-library');
  try {
    await fetch('/library', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code, category: 'Custom', description: '' }),
    });
    await loadLibrary();
    btn.textContent = '✓ Saved!'; btn.classList.add('saved');
    setTimeout(() => { btn.textContent = '◈ Save to Library'; btn.classList.remove('saved'); }, 2000);
  } catch {
    btn.textContent = '✗ Error';
    setTimeout(() => { btn.textContent = '◈ Save to Library'; }, 2000);
  }
});

/* ── MODAL / EDITOR ──────────────────────────── */
const modal       = document.getElementById('modal-overlay');
const modalEditor = document.getElementById('modal-editor');
const modalName   = document.getElementById('modal-node-name');
const editorGutter= document.getElementById('editor-gutter');

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.getElementById('modal-save').addEventListener('click', saveNode);
document.getElementById('btn-test').addEventListener('click', runTest);
document.getElementById('test-input').addEventListener('input', () => {
  clearTimeout(document.getElementById('test-input')._timer);
  document.getElementById('test-input')._timer = setTimeout(runTest, 300);
});

modalEditor.addEventListener('input', () => {
  updateGutter();
  // Auto-refresh test output while typing (debounced)
  clearTimeout(modalEditor._testTimer);
  if (document.getElementById('test-input').value !== '') {
    modalEditor._testTimer = setTimeout(runTest, 400);
  }
});
modalEditor.addEventListener('scroll', () => { editorGutter.scrollTop = modalEditor.scrollTop; });
modalEditor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = modalEditor.selectionStart, en = modalEditor.selectionEnd;
    modalEditor.value = modalEditor.value.substring(0,s) + '  ' + modalEditor.value.substring(en);
    modalEditor.selectionStart = modalEditor.selectionEnd = s + 2;
    updateGutter();
  }
});

function updateGutter() {
  const n = modalEditor.value.split('\n').length;
  editorGutter.textContent = Array.from({length:n},(_,i)=>i+1).join('\n');
}

async function openEditor(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  state.editingNodeId = nodeId;
  modalName.value = node.name;
  modalEditor.value = node.code;
  updateGutter();

  const libBtn = document.getElementById('btn-save-to-library');
  libBtn.textContent = '◈ Save to Library'; libBtn.classList.remove('saved');
  document.getElementById('test-output').classList.add('hidden');

  const testInput = document.getElementById('test-input');
  testInput.value = '';
  if (state.fileId) {
    testInput.placeholder = 'Loading sample line…';
    try {
      // For node at index idx, pass through all preceding nodes first
      const nodeIdx = state.nodes.findIndex(n => n.id === nodeId);
      const preceding = state.nodes.slice(0, nodeIdx).map(n => ({ code: n.code }));

      if (preceding.length === 0) {
        // First node — just a raw random line
        const d = await fetch(`/random-line/${state.fileId}`).then(r => r.json());
        if (d.line) testInput.value = d.line;
      } else {
        // Subsequent node — send line through preceding nodes on the server
        const d = await fetch(`/sample-line/${state.fileId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes: preceding }),
        }).then(r => r.json());

        if (d.dropped) {
          // The sampled line got dropped — try a few more times before giving up
          let found = null;
          for (let attempt = 0; attempt < 8 && !found; attempt++) {
            const retry = await fetch(`/sample-line/${state.fileId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nodes: preceding }),
            }).then(r => r.json());
            if (!retry.dropped) found = retry.line;
          }
          if (found) {
            testInput.value = found;
          } else {
            testInput.placeholder = 'All sampled lines were filtered out by preceding nodes';
          }
        } else if (d.line) {
          testInput.value = d.line;
        }
      }
    } catch {}
    if (!testInput.value) testInput.placeholder = 'Test input line...';
  }
  modal.classList.remove('hidden');
  setTimeout(() => modalEditor.focus(), 100);
}

function closeModal() { modal.classList.add('hidden'); state.editingNodeId = null; }

function saveNode() {
  if (!state.editingNodeId) return;
  const node = state.nodes.find(n => n.id === state.editingNodeId);
  if (!node) return;
  node.name = modalName.value.trim() || 'Unnamed Node';
  node.code = modalEditor.value;
  closeModal(); renderNodes(); updateRunButton();
  if (state.fileId && state.nodes.length && !state.processing) runPipeline();
}

function runTest() {
  const input = document.getElementById('test-input').value;
  const out   = document.getElementById('test-output');
  try {
    const fn = new Function('line','lineNumber', `"use strict";\n${modalEditor.value}`);
    const result = fn.call({}, input, 1);
    if (result === null || result === undefined) {
      out.textContent = '⊘ LINE DROPPED'; out.className = 'test-output skipped';
    } else {
      out.textContent = '✓ ' + String(result); out.className = 'test-output ok';
    }
  } catch (e) { out.textContent = '✗ ' + e.message; out.className = 'test-output err'; }
  out.classList.remove('hidden');
}

/* ── RUN PIPELINE ────────────────────────────── */
document.getElementById('btn-run').addEventListener('click', runPipeline);

function updateRunButton() {
  document.getElementById('btn-run').disabled = !state.fileId || !state.nodes.length || state.processing;
}

function runPipeline() {
  if (!state.fileId || !state.nodes.length || state.processing) return;
  state.processing = true; state.lastOutputFileId = null;
  clearOutput();
  document.getElementById('stats-bar').classList.remove('hidden');
  ['stat-total','stat-passed','stat-dropped','stat-errors'].forEach(id => document.getElementById(id).textContent = '…');
  document.getElementById('progress-bar').style.width = '0%';
  const runBtn = document.getElementById('btn-run');
  runBtn.classList.add('running'); runBtn.querySelector('span:last-child').textContent = 'Running…'; runBtn.disabled = true;
  document.getElementById('btn-download').disabled = true;
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'process', fileId: state.fileId, nodes: state.nodes.map(n => ({id:n.id,name:n.name,code:n.code})) }));
  }
}

function updateProgress(msg) {
  const dropped = msg.lineNumber - msg.processedCount - msg.errorCount;
  document.getElementById('stat-total').textContent   = msg.lineNumber.toLocaleString();
  document.getElementById('stat-passed').textContent  = msg.processedCount.toLocaleString();
  document.getElementById('stat-dropped').textContent = dropped.toLocaleString();
  document.getElementById('stat-errors').textContent  = msg.errorCount.toLocaleString();
}

function onProcessingComplete(msg) {
  state.processing = false; state.lastOutputFileId = state.fileId;
  const dropped = msg.totalLines - msg.processedCount - msg.errorCount;
  document.getElementById('stat-total').textContent   = msg.totalLines.toLocaleString();
  document.getElementById('stat-passed').textContent  = msg.processedCount.toLocaleString();
  document.getElementById('stat-dropped').textContent = dropped.toLocaleString();
  document.getElementById('stat-errors').textContent  = msg.errorCount.toLocaleString();
  document.getElementById('progress-bar').style.width = '100%';
  const runBtn = document.getElementById('btn-run');
  runBtn.classList.remove('running'); runBtn.querySelector('span:last-child').textContent = 'Run Pipeline';
  updateRunButton(); document.getElementById('btn-download').disabled = false;
  renderOutput(msg.results, msg.totalLines, msg.processedCount);
}

function onProcessingError(message) {
  state.processing = false;
  const runBtn = document.getElementById('btn-run');
  runBtn.classList.remove('running'); runBtn.querySelector('span:last-child').textContent = 'Run Pipeline';
  updateRunButton();
  document.getElementById('output-area').innerHTML = `<div class="output-placeholder" style="color:var(--err)">✗ Error: ${esc(message)}</div>`;
}

function clearOutput() {
  document.getElementById('output-area').innerHTML = `<div class="output-placeholder"><span class="placeholder-icon">◌</span><span>Output will appear here after running the pipeline.</span></div>`;
}

function renderOutput(results, total, passed) {
  const area = document.getElementById('output-area');
  area.innerHTML = '';
  if (!results.length) { area.innerHTML = '<div class="output-placeholder">⊘ All lines were dropped or filtered out.</div>'; return; }
  const frag = document.createDocumentFragment();
  results.forEach((line, idx) => {
    const row = document.createElement('div'); row.className = 'output-line';
    row.innerHTML = `<span class="output-linenum">${idx+1}</span><span class="output-text">${esc(line)}</span>`;
    frag.appendChild(row);
  });
  if (passed > results.length) {
    const m = document.createElement('div'); m.className = 'output-more';
    m.textContent = `… showing first ${results.length.toLocaleString()} of ${passed.toLocaleString()} output lines`;
    frag.appendChild(m);
  }
  area.appendChild(frag);
}

/* ── DOWNLOAD ────────────────────────────────── */
document.getElementById('btn-download').addEventListener('click', () => {
  if (state.lastOutputFileId) window.open(`/download/${state.lastOutputFileId}`, '_blank');
});

/* ── INIT ────────────────────────────────────── */
async function init() {
  connectWS();
  await Promise.all([loadLibrary(), loadWorkspaces()]);
  renderNodes();
}
init();
