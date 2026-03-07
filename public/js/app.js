/* ═══════════════════════════════════════════════
   PIPE — App Controller
   ═══════════════════════════════════════════════ */

const App = (() => {

  const appState = {
    fileId:    null,
    library:   [],
    libFilter: 'All',
    libSearch: '',
    workspaces: [],
    editingId: null,
    processing: false,
    lastFileId: null,
  };

  /* ── INIT ───────────────────────────────────── */
  async function init() {
    Executor.connect();
    await Promise.all([loadLibrary(), loadWorkspaces()]);
    // Create SOURCE + END nodes on first load
    Graph.addNode({ name: 'SOURCE', code: 'return line;', x: 80,  y: 140, isSource: true });
    Graph.addNode({ name: 'END',    code: '',              x: 660, y: 140, isEnd: true });
    Graph.renderEdges();
  }

  /* ── FILE UPLOAD ───────────────────────────── */
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const fileChip  = document.getElementById('file-chip');

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });
  dropzone.addEventListener('click', (e) => {
    // Don't trigger if the click came from the <label> — it already handles fileInput natively
    if (e.target.tagName === 'LABEL') return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
  document.getElementById('file-remove').addEventListener('click', (e) => { e.stopPropagation(); clearFile(); });

  async function uploadFile(file) {
    const fd = new FormData(); fd.append('file', file);
    document.getElementById('file-chip-name').textContent = file.name;
    document.getElementById('file-chip-size').textContent = '';
    dropzone.classList.add('hidden'); fileChip.classList.remove('hidden');
    try {
      const d = await fetch('/upload', { method:'POST', body:fd }).then(r => r.json());
      appState.fileId = d.fileId;
      document.getElementById('file-chip-name').textContent = d.originalName;
      document.getElementById('file-chip-size').textContent = fmtBytes(d.size);
      updateRunBtn();
    } catch { document.getElementById('file-chip-size').textContent = 'upload failed'; }
  }

  function clearFile() {
    appState.fileId = null; fileInput.value = '';
    dropzone.classList.remove('hidden'); fileChip.classList.add('hidden');
    updateRunBtn(); clearOutput();
  }

  function fmtBytes(b) {
    if (b < 1024) return b+' B';
    if (b < 1048576) return (b/1024).toFixed(1)+' KB';
    return (b/1048576).toFixed(1)+' MB';
  }

  /* ── GRAPH CHANGE HOOK ─────────────────────── */
  function onGraphChange() { updateRunBtn(); }

  /* ── RUN BUTTON ────────────────────────────── */
  function updateRunBtn() {
    const { nodes, edges } = Graph.state;
    const hasEnd  = nodes.some(n => n.isEnd);
    const hasPath = edges.some(e => {
      const to = nodes.find(n => n.id === e.toNode);
      return to && to.isEnd;
    });
    const btn = document.getElementById('btn-run');
    btn.disabled = !appState.fileId || !hasPath || appState.processing;
  }

  document.getElementById('btn-run').addEventListener('click', runPipeline);

  function runPipeline() {
    if (appState.processing) return;
    appState.processing = true; appState.lastFileId = appState.fileId;
    clearOutput();
    const panel = document.getElementById('bottom-panel');
    panel.classList.remove('hidden', 'collapsed');
    ['stat-total','stat-passed','stat-dropped','stat-errors'].forEach(id => document.getElementById(id).textContent = '…');
    document.getElementById('progress-bar').style.width = '0%';
    const btn = document.getElementById('btn-run');
    btn.classList.add('running'); btn.querySelector('span:last-child').textContent = 'Running…'; btn.disabled = true;
    document.getElementById('btn-download').disabled = true;
    Executor.run(appState.fileId);
  }

  function onWsMessage(msg) {
    if (msg.type === 'progress') {
      const dropped = msg.lineNumber - msg.processedCount - msg.errorCount;
      document.getElementById('stat-total').textContent   = msg.lineNumber.toLocaleString();
      document.getElementById('stat-passed').textContent  = msg.processedCount.toLocaleString();
      document.getElementById('stat-dropped').textContent = dropped.toLocaleString();
      document.getElementById('stat-errors').textContent  = msg.errorCount.toLocaleString();
    } else if (msg.type === 'complete') {
      appState.processing = false;
      const dropped = msg.totalLines - msg.processedCount - msg.errorCount;
      document.getElementById('stat-total').textContent   = msg.totalLines.toLocaleString();
      document.getElementById('stat-passed').textContent  = msg.processedCount.toLocaleString();
      document.getElementById('stat-dropped').textContent = dropped.toLocaleString();
      document.getElementById('stat-errors').textContent  = msg.errorCount.toLocaleString();
      document.getElementById('progress-bar').style.width = '100%';
      const btn = document.getElementById('btn-run');
      btn.classList.remove('running'); btn.querySelector('span:last-child').textContent = 'Run';
      updateRunBtn(); document.getElementById('btn-download').disabled = false;
      renderOutput(msg.results, msg.totalLines, msg.processedCount);
    } else if (msg.type === 'error') {
      appState.processing = false;
      const btn = document.getElementById('btn-run');
      btn.classList.remove('running'); btn.querySelector('span:last-child').textContent = 'Run';
      updateRunBtn();
      document.getElementById('output-area').innerHTML =
        `<div class="output-placeholder" style="color:var(--err)">✗ ${esc(msg.message)}</div>`;
    }
  }

  function clearOutput() {
    document.getElementById('output-area').innerHTML =
      `<div class="output-placeholder"><span>◌</span><span>Output will appear here after running.</span></div>`;
  }

  function renderOutput(results, total, passed) {
    const area = document.getElementById('output-area');
    area.innerHTML = '';
    if (!results.length) { area.innerHTML = '<div class="output-placeholder">⊘ No output — all lines dropped.</div>'; return; }
    const frag = document.createDocumentFragment();
    results.forEach((line, i) => {
      const row = document.createElement('div'); row.className = 'output-line';
      row.innerHTML = `<span class="output-linenum">${i+1}</span><span class="output-text">${esc(line)}</span>`;
      frag.appendChild(row);
    });
    if (passed > results.length) {
      const m = document.createElement('div'); m.className = 'output-more';
      m.textContent = `… showing first ${results.length.toLocaleString()} of ${passed.toLocaleString()} lines`;
      frag.appendChild(m);
    }
    area.appendChild(frag);
  }

  document.getElementById('btn-collapse-output').addEventListener('click', () => {
    const p = document.getElementById('bottom-panel');
    const collapsed = p.classList.toggle('collapsed');
    document.getElementById('btn-collapse-output').textContent = collapsed ? '▲' : '▼';
  });

  document.getElementById('btn-download').addEventListener('click', () => {
    if (appState.lastFileId) window.open(`/download/${appState.lastFileId}`, '_blank');
  });

  /* ── ADD NODE ──────────────────────────────── */
  document.getElementById('btn-add-node').addEventListener('click', openLibrary);

  /* ── NODE EDITOR ────────────────────────────── */
  const modalOverlay = document.getElementById('modal-overlay');
  const modalEditor  = document.getElementById('modal-editor');
  const modalName    = document.getElementById('modal-node-name');
  const editorGutter = document.getElementById('editor-gutter');

  document.getElementById('modal-close').addEventListener('click',  closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
  document.getElementById('modal-save').addEventListener('click',   saveNode);

  modalEditor.addEventListener('input', () => {
    updateGutter();
    clearTimeout(modalEditor._t);
    if (hasTestValues()) modalEditor._t = setTimeout(runTest, 400);
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

  function hasTestValues() {
    return [...document.querySelectorAll('.test-input-field')].some(f => f.value !== '');
  }

  async function openEditor(nodeId) {
    const node = Graph.state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    appState.editingId = nodeId;
    modalName.value = node.name;
    modalEditor.value = node.code;
    updateGutter();

    // Build hint + test inputs based on incoming edges
    buildEditorHint(node);
    await buildTestInputs(node);

    document.getElementById('test-output').classList.add('hidden');
    const libBtn = document.getElementById('btn-save-to-library');
    libBtn.textContent = '◈ Save to Library'; libBtn.classList.remove('saved');

    modalOverlay.classList.remove('hidden');
    setTimeout(() => modalEditor.focus(), 80);
  }

  function buildEditorHint(node) {
    const hint = document.getElementById('editor-hint');
    const varNames = Graph.getInputVarNames(node.id);

    if (varNames.length === 0) {
      // source node
      hint.innerHTML = `
        <span style="color:var(--textM)">Available: </span>
        <code>line</code> — raw input line &nbsp;|&nbsp;
        <code>lineNumber</code> — 1-based index<br>
        <span style="color:var(--textM)">Return:</span> string to pass on, or <code>null</code> to drop.`;
    } else {
      const vars = varNames.map(v => `<code class="hint-var">${v}</code>`).join(', ');
      hint.innerHTML = `
        <span style="color:var(--textM)">Inputs: </span>${vars} &nbsp;|&nbsp; <code>lineNumber</code><br>
        <span style="color:var(--textM)">Return:</span> string to pass on, or <code>null</code> to drop.`;
    }
  }

  async function buildTestInputs(node) {
    const wrap = document.getElementById('test-inputs-wrap');
    wrap.innerHTML = '';

    const incoming = Graph.state.edges.filter(e => e.toNode === node.id);
    const varNames = Graph.getInputVarNames(node.id);

    if (incoming.length === 0) {
      // source node or unconnected — single line input with random sample
      const row = document.createElement('div'); row.className = 'test-input-row';
      row.innerHTML = `
        <div class="test-input-varname">line</div>
        <input class="test-input-field" data-var="line" placeholder="Test input line…" autocomplete="off">
        <button class="btn-test">TEST</button>`;
      row.querySelector('.btn-test').addEventListener('click', runTest);
      row.querySelector('.test-input-field').addEventListener('input', debounceTest);
      wrap.appendChild(row);

      if (appState.fileId) {
        const field = row.querySelector('.test-input-field');
        field.placeholder = 'Loading sample…';
        try {
          const d = await fetch(`/random-line/${appState.fileId}`).then(r => r.json());
          if (d.line) { field.value = d.line; field.placeholder = ''; runTest(); }
        } catch {}
        field.placeholder = field.value ? '' : 'Test input line…';
      }
    } else {
      // multiple inputs — one row per input with sample from preceding pipeline
      for (let i = 0; i < varNames.length; i++) {
        const varName  = varNames[i];
        const edge     = incoming[i];
        const srcNode  = Graph.state.nodes.find(n => n.id === edge.fromNode);
        const row = document.createElement('div'); row.className = 'test-input-row';
        row.innerHTML = `
          <div class="test-input-varname">${esc(varName)}</div>
          <input class="test-input-field" data-var="${esc(varName)}" placeholder="from ${esc(srcNode ? srcNode.name : '?')}…" autocomplete="off">`;
        row.querySelector('.test-input-field').addEventListener('input', debounceTest);
        wrap.appendChild(row);
      }

      // Add TEST button at the bottom
      const btnRow = document.createElement('div'); btnRow.className = 'test-run-row';
      btnRow.innerHTML = `<button class="btn-test" style="margin-left:auto">TEST</button>`;
      btnRow.querySelector('.btn-test').addEventListener('click', runTest);
      wrap.appendChild(btnRow);

      // Populate each input with sample from its source chain
      if (appState.fileId) {
        for (let i = 0; i < incoming.length; i++) {
          const edge = incoming[i];
          const field = wrap.querySelectorAll('.test-input-field')[i];
          if (!field) continue;
          field.placeholder = 'Loading sample…';
          try {
            // Collect the path from SOURCE to this input's source node
            const pathNodes = getPathToNode(edge.fromNode);
            let result;
            if (pathNodes.length === 0) {
              result = await fetch(`/random-line/${appState.fileId}`).then(r => r.json());
            } else {
              result = await sampleThroughNodes(pathNodes);
            }
            if (result && !result.dropped && result.line) {
              field.value = result.line;
              field.placeholder = '';
            } else {
              field.placeholder = 'No passing sample found';
            }
          } catch { field.placeholder = '…'; }
        }
        if (hasTestValues()) runTest();
      }
    }
  }

  function getPathToNode(targetId) {
    // BFS to find one path from source to targetId, returns ordered node codes
    const { nodes, edges } = Graph.state;
    const source = nodes.find(n => n.isSource);
    if (!source) return [];
    if (source.id === targetId) return [];

    // BFS
    const queue = [[source.id]];
    const visited = new Set();
    while (queue.length) {
      const path = queue.shift();
      const cur = path[path.length - 1];
      if (cur === targetId) {
        // return nodes in path except the last (we want preceding nodes)
        return path.slice(0, -1).map(id => nodes.find(n => n.id === id)).filter(Boolean);
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      edges.filter(e => e.fromNode === cur).forEach(e => queue.push([...path, e.toNode]));
    }
    return [];
  }

  async function sampleThroughNodes(nodeList) {
    if (!appState.fileId) return null;
    const codes = nodeList.filter(n => !n.isSource && !n.isEnd).map(n => ({ code: n.code }));
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(`/sample-line/${appState.fileId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes: codes }),
      }).then(r => r.json());
      if (!res.dropped) return res;
    }
    return { dropped: true };
  }

  function debounceTest() {
    clearTimeout(debounceTest._t);
    debounceTest._t = setTimeout(runTest, 350);
  }

  function runTest() {
    const node = Graph.state.nodes.find(n => n.id === appState.editingId);
    if (!node) return;
    const out = document.getElementById('test-output');
    const fields = [...document.querySelectorAll('.test-input-field')];
    const varNames = Graph.getInputVarNames(node.id);

    // Build argument list
    let argNames, argValues;
    if (varNames.length === 0) {
      // source — single `line` var
      argNames  = ['line', 'lineNumber'];
      argValues = [fields[0]?.value ?? '', 1];
    } else {
      argNames  = [...varNames, 'lineNumber'];
      argValues = [...fields.map(f => f.value), 1];
    }

    try {
      const fn = new Function(...argNames, `"use strict";\n${modalEditor.value}`);
      const result = fn(...argValues);
      if (result === null || result === undefined) {
        out.textContent = '⊘ LINE DROPPED'; out.className = 'test-output skipped';
      } else {
        out.textContent = '✓ ' + String(result); out.className = 'test-output ok';
      }
    } catch (e) {
      out.textContent = '✗ ' + e.message; out.className = 'test-output err';
    }
    out.classList.remove('hidden');
  }

  function closeModal() { modalOverlay.classList.add('hidden'); appState.editingId = null; }

  function saveNode() {
    if (!appState.editingId) return;
    const name = modalName.value.trim() || 'Unnamed';
    const code = modalEditor.value;
    Graph.updateNode(appState.editingId, { name, code });
    closeModal();
    onGraphChange();
    // Auto-run after saving if file loaded and graph has a path to END
    if (appState.fileId && !appState.processing) {
      const { nodes, edges } = Graph.state;
      const hasPath = edges.some(e => { const t = nodes.find(n => n.id === e.toNode); return t && t.isEnd; });
      if (hasPath) runPipeline();
    }
  }

  /* ── SAVE TO LIBRARY ────────────────────────── */
  document.getElementById('btn-save-to-library').addEventListener('click', async () => {
    const name = modalName.value.trim() || 'Unnamed';
    const code = modalEditor.value;
    const btn  = document.getElementById('btn-save-to-library');
    try {
      await fetch('/library', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name, code, category:'Custom', description:'' }) });
      await loadLibrary();
      btn.textContent = '✓ Saved!'; btn.classList.add('saved');
      setTimeout(() => { btn.textContent = '◈ Save to Library'; btn.classList.remove('saved'); }, 2000);
    } catch {
      btn.textContent = '✗ Error';
      setTimeout(() => { btn.textContent = '◈ Save to Library'; }, 2000);
    }
  });

  /* ── LIBRARY ────────────────────────────────── */
  async function loadLibrary() {
    appState.library = await fetch('/library').then(r => r.json());
  }

  let _libraryMode = 'add'; // 'add' | 'graph' — 'graph' means auto-connect after pick

  function openLibrary() {
    _libraryMode = 'add';
    appState.libFilter = 'All'; appState.libSearch = '';
    document.getElementById('library-search').value = '';
    renderLibrary();
    document.getElementById('library-overlay').classList.remove('hidden');
  }

  function openLibraryForGraph() {
    _libraryMode = 'graph';
    appState.libFilter = 'All'; appState.libSearch = '';
    document.getElementById('library-search').value = '';
    renderLibrary();
    document.getElementById('library-overlay').classList.remove('hidden');
  }

  function closeLibrary() { document.getElementById('library-overlay').classList.add('hidden'); }

  function renderLibrary() {
    const cats = ['All', ...new Set(appState.library.map(n => n.category).filter(Boolean))];
    const catEl = document.getElementById('library-categories');
    catEl.innerHTML = '';
    cats.forEach(cat => {
      const b = document.createElement('button');
      b.className = 'cat-btn' + (appState.libFilter === cat ? ' active' : '');
      b.textContent = cat;
      b.addEventListener('click', () => { appState.libFilter = cat; renderLibrary(); });
      catEl.appendChild(b);
    });
    const q = appState.libSearch.toLowerCase();
    const filtered = appState.library.filter(n => {
      const mc = appState.libFilter === 'All' || n.category === appState.libFilter;
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
        <div class="lib-card-cat cat-${esc(entry.category)}">${esc(entry.category)}</div>
        <div class="lib-card-name">${esc(entry.name)}</div>
        <div class="lib-card-desc">${esc(entry.description||'')}</div>
        ${!isBuiltin ? `<div class="lib-card-actions"><button class="lib-card-btn del-lib" data-id="${esc(entry.id)}">✕</button></div>` : ''}`;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.lib-card-btn')) return;
        closeLibrary();
        const node = Graph.addNode({ name: entry.name, code: entry.code });
        if (_libraryMode === 'graph') {
          Graph.applyPendingConnect(node);
          openEditor(node.id);
        } else {
          openEditor(node.id);
        }
      });
      if (!isBuiltin) {
        card.querySelector('.del-lib').addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(`/library/${entry.id}`, { method:'DELETE' });
          await loadLibrary(); renderLibrary();
        });
      }
      grid.appendChild(card);
    });
  }

  document.getElementById('library-search').addEventListener('input', (e) => { appState.libSearch = e.target.value; renderLibrary(); });
  document.getElementById('library-close').addEventListener('click', closeLibrary);
  document.getElementById('library-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('library-overlay')) closeLibrary(); });
  document.getElementById('btn-new-from-scratch').addEventListener('click', () => {
    closeLibrary();
    const node = Graph.addNode({ name: 'New Node', code: 'return line;\n' });
    if (_libraryMode === 'graph') {
      Graph.applyPendingConnect(node);
    }
    openEditor(node.id);
  });

  /* ── WORKSPACES ─────────────────────────────── */
  async function loadWorkspaces() {
    appState.workspaces = await fetch('/workspaces').then(r => r.json());
  }

  document.getElementById('btn-workspaces').addEventListener('click', () => {
    renderWorkspaceList();
    document.getElementById('ws-overlay').classList.remove('hidden');
  });
  document.getElementById('ws-close').addEventListener('click', () => document.getElementById('ws-overlay').classList.add('hidden'));
  document.getElementById('ws-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('ws-overlay')) document.getElementById('ws-overlay').classList.add('hidden'); });

  function renderWorkspaceList() {
    const list = document.getElementById('ws-list'); list.innerHTML = '';
    if (!appState.workspaces.length) { list.innerHTML = '<div class="ws-empty">No saved workspaces yet.<br>Build a graph and click <strong>Save</strong>.</div>'; return; }
    appState.workspaces.forEach(ws => {
      const item = document.createElement('div'); item.className = 'ws-item';
      const d = new Date(ws.savedAt);
      item.innerHTML = `
        <div class="ws-item-icon">◫</div>
        <div class="ws-item-info">
          <div class="ws-item-name">${esc(ws.name)}</div>
          <div class="ws-item-meta">${(ws.graph?.nodes?.length||0)} nodes · ${d.toLocaleDateString()} ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <div class="ws-item-actions">
          <button class="ws-action-btn load">Load</button>
          <button class="ws-action-btn del">✕</button>
        </div>`;
      item.querySelector('.ws-action-btn.load').addEventListener('click', (e) => { e.stopPropagation(); loadWorkspace(ws); });
      item.querySelector('.ws-action-btn.del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/workspaces/${ws.id}`, { method:'DELETE' });
        await loadWorkspaces(); renderWorkspaceList();
      });
      item.addEventListener('click', () => loadWorkspace(ws));
      list.appendChild(item);
    });
  }

  function loadWorkspace(ws) {
    Graph.deserialise(ws.graph);
    document.getElementById('ws-overlay').classList.add('hidden');
    onGraphChange();
  }

  document.getElementById('btn-save-workspace').addEventListener('click', () => {
    const { nodes, edges } = Graph.state;
    if (!nodes.length) return;
    const input = document.getElementById('ws-name-input');
    input.value = '';
    document.getElementById('ws-save-overlay').classList.remove('hidden');
    setTimeout(() => input.focus(), 80);
  });
  document.getElementById('ws-save-close').addEventListener('click',   () => document.getElementById('ws-save-overlay').classList.add('hidden'));
  document.getElementById('ws-save-cancel').addEventListener('click',  () => document.getElementById('ws-save-overlay').classList.add('hidden'));
  document.getElementById('ws-save-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('ws-save-overlay')) document.getElementById('ws-save-overlay').classList.add('hidden'); });
  document.getElementById('ws-save-confirm').addEventListener('click', saveWorkspace);
  document.getElementById('ws-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveWorkspace(); });

  async function saveWorkspace() {
    const name = document.getElementById('ws-name-input').value.trim();
    if (!name) { document.getElementById('ws-name-input').focus(); return; }
    await fetch('/workspaces', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, graph: Graph.serialise() }),
    });
    await loadWorkspaces();
    document.getElementById('ws-save-overlay').classList.add('hidden');
    const btn = document.getElementById('btn-save-workspace');
    const orig = btn.querySelector('span:last-child').textContent;
    btn.querySelector('span:last-child').textContent = '✓ Saved';
    btn.style.borderColor = 'var(--ok)'; btn.style.color = 'var(--ok)';
    setTimeout(() => { btn.querySelector('span:last-child').textContent = orig; btn.style.borderColor=''; btn.style.color=''; }, 2000);
  }

  /* ── HELPERS ────────────────────────────────── */
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* ── PUBLIC ─────────────────────────────────── */
  return { init, openEditor, onGraphChange, onWsMessage, openLibraryForGraph };
})();

App.init();
