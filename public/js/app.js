/* ═══════════════════════════════════════════════
   PIPE — App Controller
   ═══════════════════════════════════════════════ */

const App = (() => {

  const appState = {
    files:     {},   // { fileId: { name, size } } — all known uploaded files
    library:   [],
    libFilter: 'All',
    libSearch: '',
    workspaces: [],
    editingId: null,
    processing: false,
    lastOutputFileId: null,
  };

  /* ── LOCAL STORAGE AUTO-SAVE ───────────────── */
  const LS_KEY      = 'pipe_autosave';
  const LS_FILES_KEY = 'pipe_files'; // { fileId: { name, size } }

  function saveToLS() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Graph.serialise())); } catch {}
  }

  function saveFilesToLS() {
    try { localStorage.setItem(LS_FILES_KEY, JSON.stringify(appState.files)); } catch {}
  }

  function loadFromLS() {
    try { const r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
  }

  function loadFilesFromLS() {
    try { const r = localStorage.getItem(LS_FILES_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
  }

  // Called by graph.js to get file info for a SOURCE node
  function getFileInfo(fileId) {
    if (!fileId) return null;
    return appState.files[fileId] || null;
  }

  /* ── INIT ───────────────────────────────────── */
  async function init() {
    Executor.connect();
    await Promise.all([loadLibrary(), loadWorkspaces()]);

    // Restore known files, verify each still exists on server
    const savedFiles = loadFilesFromLS();
    for (const [fileId, info] of Object.entries(savedFiles)) {
      try {
        const r = await fetch(`/file-exists/${fileId}`).then(r => r.json());
        if (r.exists) appState.files[fileId] = info;
      } catch {}
    }
    saveFilesToLS(); // prune missing files

    // Restore graph
    const saved = loadFromLS();
    if (saved && saved.nodes && saved.nodes.length) {
      Graph.deserialise(saved);
    } else {
      Graph.addNode({ name: 'SOURCE', code: 'return line;', x: 80,  y: 140, isSource: true });
      Graph.addNode({ name: 'END',    code: '',              x: 660, y: 140, isEnd: true });
      Graph.renderEdges();
    }
    updateRunBtn();
  }

  /* ── FILE UPLOAD (per SOURCE node) ─────────── */
  function fmtBytes(b) {
    if (b < 1024) return b+' B';
    if (b < 1048576) return (b/1024).toFixed(1)+' KB';
    return (b/1048576).toFixed(1)+' MB';
  }

  // Hidden file inputs keyed by nodeId
  const _fileInputs = {};

  function triggerSourceUpload(nodeId) {
    if (!_fileInputs[nodeId]) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.style.display = 'none';
      inp.addEventListener('change', () => { if (inp.files[0]) uploadFileForSource(nodeId, inp.files[0]); });
      document.body.appendChild(inp);
      _fileInputs[nodeId] = inp;
    }
    _fileInputs[nodeId].click();
  }

  async function uploadFileForSource(nodeId, file) {
    const node = Graph.state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    const body = document.querySelector(`.gnode[data-id="${nodeId}"] .gnode-source-body`);
    if (body) body.innerHTML = `<div class="source-uploading"><span class="source-spin">◌</span> uploading…</div>`;
    try {
      const fd = new FormData(); fd.append('file', file);
      const d  = await fetch('/upload', { method:'POST', body:fd }).then(r => r.json());
      appState.files[d.fileId] = { name: d.originalName, size: d.size };
      saveFilesToLS();
      // Update node name to filename (without extension) if still default
      const newName = (node.name === 'SOURCE' || node.name === node.fileId) ? d.originalName.replace(/\.[^.]+$/, '') : node.name;
      Graph.updateNode(nodeId, { fileId: d.fileId, name: newName });
      onGraphChange();
    } catch {
      if (body) body.innerHTML = `<div class="source-upload-err">✗ upload failed</div>`;
    }
  }

  function clearFileForSource(nodeId) {
    Graph.updateNode(nodeId, { fileId: null });
    onGraphChange();
  }

  // Called by graph.js to get file info for a SOURCE node display
  function getFileInfo(fileId) {
    if (!fileId) return null;
    return appState.files[fileId] || null;
  }

  // Legacy alias — kept for compatibility
  function bindSourceUpload() {}

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Clear canvas and forget all uploaded files?')) return;
    try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_FILES_KEY); } catch {}
    appState.files = {};
    Graph.state.nodes = [];
    Graph.state.edges = [];
    Graph.state.nextId = 1;
    Graph.state.nextPos = { x: 80, y: 80 };
    Graph.addNode({ name: 'SOURCE', code: 'return line;', x: 80,  y: 140, isSource: true });
    Graph.addNode({ name: 'END',    code: '',              x: 660, y: 140, isEnd: true });
    Graph.renderAll();
    clearOutput();
    document.getElementById('bottom-panel').classList.add('hidden');
  });


  function onGraphChange() { updateRunBtn(); saveToLS(); }

  /* ── RUN BUTTON ────────────────────────────── */
  function updateRunBtn() {
    const { nodes, edges } = Graph.state;
    const sourceNodes    = nodes.filter(n => n.isSource);
    const generatorNodes = nodes.filter(n => n.isGenerator);
    const allSourcesHaveFiles = sourceNodes.every(n => n.fileId && appState.files[n.fileId]);
    const hasAnyRoot = (sourceNodes.length + generatorNodes.length) > 0;
    const hasPath = edges.some(e => { const t = nodes.find(n => n.id === e.toNode); return t && t.isEnd; });
    const btn = document.getElementById('btn-run');
    btn.disabled = !hasAnyRoot || !allSourcesHaveFiles || !hasPath || appState.processing;
  }

  document.getElementById('btn-run').addEventListener('click', runPipeline);

  function runPipeline() {
    if (appState.processing) return;
    appState.processing = true;
    clearOutput();
    const panel = document.getElementById('bottom-panel');
    panel.classList.remove('hidden', 'collapsed');
    ['stat-total','stat-passed','stat-dropped','stat-errors'].forEach(id => document.getElementById(id).textContent = '…');
    document.getElementById('progress-bar').style.width = '0%';
    const btn = document.getElementById('btn-run');
    btn.classList.add('running'); btn.querySelector('span:last-child').textContent = 'Running…'; btn.disabled = true;
    document.getElementById('btn-download').disabled = true;
    // Pass the first SOURCE node's fileId for output naming; executor handles multi-source
    const firstSource = Graph.state.nodes.find(n => n.isSource);
    appState.lastOutputFileId = firstSource ? firstSource.fileId : null;
    Executor.run();
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
    if (appState.lastOutputFileId) window.open(`/download/${appState.lastOutputFileId}`, '_blank');
  });

  /* ── ADD NODE / ADD SOURCE ──────────────────── */
  document.getElementById('btn-add-node').addEventListener('click', openLibrary);
  document.getElementById('btn-add-source').addEventListener('click', () => {
    const sources = Graph.state.nodes.filter(n => n.isSource);
    const lastSrc = sources[sources.length - 1];
    Graph.addNode({ name: 'SOURCE', code: 'return line;', isSource: true,
      x: lastSrc ? lastSrc.x : 80,
      y: lastSrc ? lastSrc.y + 160 : 140,
    });
    onGraphChange();
  });

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

      // Populate with a random sample — find nearest source with file
      const found = getPathToNode(node.id);
      if (found) {
        const field = row.querySelector('.test-input-field');
        field.placeholder = 'Loading sample…';
        try {
          const pathNodes = found.path.filter(n => !n.isSource && !n.isEnd && !n.isGenerator);
          let result;
          if (pathNodes.length === 0) {
            result = await sampleThroughNodes([], found.sourceNode);
          } else {
            result = await sampleThroughNodes(pathNodes, found.sourceNode);
          }
          if (result && !result.dropped && result.line) { field.value = result.line; field.placeholder = ''; runTest(); }
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
      for (let i = 0; i < incoming.length; i++) {
        const edge  = incoming[i];
        const field = wrap.querySelectorAll('.test-input-field')[i];
        if (!field) continue;
        field.placeholder = 'Loading sample…';
        try {
          const found = getPathToNode(edge.fromNode);
          if (!found) { field.placeholder = 'no source'; continue; }
          const pathNodes = found.path.filter(n => !n.isSource && !n.isEnd && !n.isGenerator);
          const result = await sampleThroughNodes(pathNodes, found.sourceNode);
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

  function getPathToNode(targetId) {
    const { nodes, edges } = Graph.state;
    // Treat generators as roots too (they don't need a fileId)
    const roots = nodes.filter(n => (n.isSource && n.fileId) || n.isGenerator);
    if (!roots.length) return null;

    for (const root of roots) {
      if (root.id === targetId) return { sourceNode: root, path: [] };
      const queue = [[root.id]];
      const visited = new Set();
      while (queue.length) {
        const path = queue.shift();
        const cur = path[path.length - 1];
        if (cur === targetId) {
          return {
            sourceNode: root,
            path: path.slice(0, -1).map(id => nodes.find(n => n.id === id)).filter(Boolean),
          };
        }
        if (visited.has(cur)) continue;
        visited.add(cur);
        edges.filter(e => e.fromNode === cur).forEach(e => queue.push([...path, e.toNode]));
      }
    }
    return null;
  }

  async function sampleThroughNodes(nodeList, sourceNode) {
    // sourceNode can be a file source or a generator
    async function getRawLine() {
      if (sourceNode.isGenerator) {
        const d = await fetch('/generator-sample', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: sourceNode.code, count: 1 }),
        }).then(r => r.json());
        return d.lines?.[0] ?? null;
      }
      const d = await fetch(`/random-line/${sourceNode.fileId}`).then(r => r.json());
      return d.line ?? null;
    }

    if (!nodeList.length) {
      const line = await getRawLine();
      return line !== null ? { line, dropped: false } : null;
    }

    const codes = nodeList.filter(n => !n.isSource && !n.isEnd && !n.isGenerator).map(n => ({ code: n.code }));
    for (let attempt = 0; attempt < 8; attempt++) {
      if (sourceNode.isGenerator) {
        const rawLine = await getRawLine();
        if (!rawLine) return null;
        if (!codes.length) return { line: rawLine, dropped: false };
        const res = await fetch(`/sample-line/__generator__`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes: codes, line: rawLine }),
        }).then(r => r.json()).catch(() => ({ dropped: true }));
        if (!res.dropped) return res;
      } else {
        const res = await fetch(`/sample-line/${sourceNode.fileId}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes: codes }),
        }).then(r => r.json());
        if (!res.dropped) return res;
      }
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
    // Auto-run after saving if there are sources and graph has a path to END
    const { nodes, edges } = Graph.state;
    const hasSources = nodes.some(n => (n.isSource && n.fileId) || n.isGenerator);
    const hasPath = edges.some(e => { const t = nodes.find(n => n.id === e.toNode); return t && t.isEnd; });
    if (hasSources && hasPath && !appState.processing) runPipeline();
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
        // Source types spawn their own special node types
        const nodeOpts = { name: entry.name, code: entry.code || '' };
        if (entry.isSource)    nodeOpts.isSource    = true;
        if (entry.isGenerator) nodeOpts.isGenerator = true;
        if (!entry.isSource && !entry.isGenerator && !entry.code) nodeOpts.code = 'return line;\n';
        const node = Graph.addNode(nodeOpts);
        if (_libraryMode === 'graph' && !entry.isSource && !entry.isGenerator) {
          Graph.applyPendingConnect(node);
        }
        if (!entry.isSource) openEditor(node.id);
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
  return { init, openEditor, onGraphChange, onWsMessage, openLibraryForGraph, getFileInfo, bindSourceUpload, triggerSourceUpload, uploadFileForSource, clearFileForSource, updateRunBtn };
})();

App.init();
