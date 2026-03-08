/* ═══════════════════════════════════════════════
   PIPE — Graph Engine
   Manages: nodes on canvas, ports, SVG connections
   ═══════════════════════════════════════════════ */

const Graph = (() => {

  // ── State ──────────────────────────────────────
  const state = {
    nodes: [],       // [{ id, name, code, x, y, isSource, isEnd, fileId }]
    edges: [],       // [{ id, fromNode, fromPort, toNode, toPort }]
    selected: null,
    nextId: 1,
    nextPos: { x: 80, y: 80 },
  };

  // ── DOM refs ────────────────────────────────────
  const canvas   = document.getElementById('canvas');
  const svgGroup = document.getElementById('connections-group');
  const dragEdge = document.getElementById('drag-edge');
  const hint     = document.getElementById('canvas-hint');

  // ── Drag-edge state ─────────────────────────────
  let draggingEdge = null; // { fromNode, fromPort, el, startX, startY }

  // ── Utils ────────────────────────────────────────
  function uid() { return 'n' + (state.nextId++); }
  function edgeId() { return 'e' + Date.now() + Math.random().toString(36).slice(2,5); }
  function fmtBytes(b) { if (!b) return ''; if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }

  /** Convert node name → valid JS identifier */
  function toVarName(name) {
    let s = name.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^[0-9]/, '_$&');
    return s || 'input';
  }

  /** Get unique var names for the inputs of a node, handling duplicates with suffixes */
  function getInputVarNames(nodeId) {
    const incoming = state.edges.filter(e => e.toNode === nodeId);
    const rawNames = incoming.map(e => {
      const src = state.nodes.find(n => n.id === e.fromNode);
      return src ? toVarName(src.name) : 'input';
    });
    // deduplicate: if same name appears twice, add _1, _2 suffixes
    const counts = {};
    rawNames.forEach(n => { counts[n] = (counts[n] || 0) + 1; });
    const seen = {};
    return rawNames.map(n => {
      if (counts[n] === 1) return n;
      seen[n] = (seen[n] || 0) + 1;
      return n + '_' + seen[n];
    });
  }

  // ── Port position (relative to canvas) ──────────
  function getPortPos(nodeId, portType, portIndex) {
    const el = document.querySelector(`.gnode[data-id="${nodeId}"]`);
    if (!el) return { x: 0, y: 0 };
    const cRect = canvas.parentElement.getBoundingClientRect();
    const nRect = el.getBoundingClientRect();
    const ports = el.querySelectorAll(portType === 'out' ? '.port-out' : '.port-in');
    const port  = ports[portIndex];
    if (!port) return { x: nRect.left - cRect.left + nRect.width / 2, y: nRect.top - cRect.top };
    const pRect = port.getBoundingClientRect();
    return {
      x: pRect.left - cRect.left + pRect.width / 2,
      y: pRect.top  - cRect.top  + pRect.height / 2,
    };
  }

  // ── Bezier point-distance helper ────────────────
  // Sample N points on cubic bezier, return min distance to (px,py)
  function distToBezier(px, py, from, to, samples = 40) {
    const cpy = Math.max(Math.abs(to.y - from.y) * 0.5, 60);
    const p0 = { x: from.x, y: from.y };
    const p1 = { x: from.x, y: from.y + cpy };
    const p2 = { x: to.x,   y: to.y   - cpy };
    const p3 = { x: to.x,   y: to.y };
    let minD = Infinity, bestT = 0;
    for (let i = 0; i <= samples; i++) {
      const t  = i / samples;
      const t2 = 1 - t;
      const x  = t2**3*p0.x + 3*t2**2*t*p1.x + 3*t2*t**2*p2.x + t**3*p3.x;
      const y  = t2**3*p0.y + 3*t2**2*t*p1.y + 3*t2*t**2*p2.y + t**3*p3.y;
      const d  = Math.hypot(px - x, py - y);
      if (d < minD) { minD = d; bestT = t; }
    }
    // Return closest point coords too
    const t = bestT, t2 = 1 - t;
    return {
      dist: minD,
      x: t2**3*p0.x + 3*t2**2*t*p1.x + 3*t2*t**2*p2.x + t**3*p3.x,
      y: t2**3*p0.y + 3*t2**2*t*p1.y + 3*t2*t**2*p2.y + t**3*p3.y,
    };
  }

  // ── Edge hover dot — driven by canvas-wrap mousemove ──
  const edgeDot = (() => {
    const dot = document.createElement('div');
    dot.className = 'edge-dot';
    dot.title = 'Click: remove  ·  Double-click: insert node';
    dot.style.display = 'none';
    canvas.parentElement.appendChild(dot);

    let activeEdgeId = null;
    let clickTimer   = null;

    // Global mousemove on canvas-wrap — always fires regardless of z-index
    canvas.parentElement.addEventListener('mousemove', (e) => {
      if (draggingEdge) return; // don't interfere with edge drawing
      const cRect = canvas.parentElement.getBoundingClientRect();
      const mx = e.clientX - cRect.left;
      const my = e.clientY - cRect.top;

      const THRESHOLD = 14; // px — how close you need to be to the curve
      let closest = null, closestDist = THRESHOLD;

      state.edges.forEach(edge => {
        const from = getPortPos(edge.fromNode, 'out', 0);
        const to   = getPortPos(edge.toNode,   'in',  edge.toPort || 0);
        const r    = distToBezier(mx, my, from, to);
        if (r.dist < closestDist) { closestDist = r.dist; closest = { edge, pt: r }; }
      });

      if (closest) {
        activeEdgeId = closest.edge.id;
        dot.style.left    = closest.pt.x + 'px';
        dot.style.top     = closest.pt.y + 'px';
        dot.style.display = 'block';
        // Highlight corresponding SVG path
        document.querySelectorAll('.conn-path').forEach(p =>
          p.classList.toggle('hovered', p.dataset.edge === activeEdgeId));
      } else {
        if (activeEdgeId) {
          document.querySelectorAll('.conn-path').forEach(p => p.classList.remove('hovered'));
          activeEdgeId = null;
        }
        // Only hide if mouse isn't on the dot itself
        if (e.target !== dot) dot.style.display = 'none';
      }
    });

    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const eid = activeEdgeId;
      if (!eid) return;
      if (clickTimer) {
        clearTimeout(clickTimer); clickTimer = null;
        dot.style.display = 'none'; activeEdgeId = null;
        document.querySelectorAll('.conn-path').forEach(p => p.classList.remove('hovered'));
        openLibraryForInsert(eid);
      } else {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          dot.style.display = 'none'; activeEdgeId = null;
          document.querySelectorAll('.conn-path').forEach(p => p.classList.remove('hovered'));
          removeEdge(eid);
        }, 260);
      }
    });

    dot.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const eid = activeEdgeId;
      dot.style.display = 'none'; activeEdgeId = null;
      document.querySelectorAll('.conn-path').forEach(p => p.classList.remove('hovered'));
      if (eid) removeEdge(eid);
    });

    return {};
  })();

  // ── Draw all SVG edges ──────────────────────────
  function renderEdges() {
    svgGroup.innerHTML = '';
    state.edges.forEach(edge => {
      const from = getPortPos(edge.fromNode, 'out', 0);
      const to   = getPortPos(edge.toNode,   'in',  edge.toPort || 0);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'conn-path');
      path.setAttribute('data-edge', edge.id);
      path.setAttribute('d', bezier(from, to));
      svgGroup.appendChild(path);
    });
    updatePortConnectedState();
  }

  function bezier(from, to) {
    const dy = Math.abs(to.y - from.y);
    const cp = Math.max(dy * 0.5, 60);
    return `M${from.x},${from.y} C${from.x},${from.y + cp} ${to.x},${to.y - cp} ${to.x},${to.y}`;
  }

  function updatePortConnectedState() {
    document.querySelectorAll('.port').forEach(p => p.classList.remove('connected'));
    state.edges.forEach(e => {
      const fromEl = document.querySelector(`.gnode[data-id="${e.fromNode}"] .port-out`);
      const toEl   = document.querySelectorAll(`.gnode[data-id="${e.toNode}"] .port-in`)[e.toPort || 0];
      if (fromEl) fromEl.classList.add('connected');
      if (toEl)   toEl.classList.add('connected');
    });
  }

  // ── Add / remove nodes ─────────────────────────
  function addNode(opts = {}) {
    const id   = uid();
    const node = {
      id,
      name:        opts.name        || 'Node',
      code:        opts.code        !== undefined ? opts.code : 'return line;\n',
      x:           opts.x           !== undefined ? opts.x : state.nextPos.x,
      y:           opts.y           !== undefined ? opts.y : state.nextPos.y,
      isSource:    opts.isSource    || false,
      isEnd:       opts.isEnd       || false,
      isGenerator: opts.isGenerator || false,
      fileId:      opts.fileId      || null,
    };
    state.nodes.push(node);
    state.nextPos.x += 260;
    if (state.nextPos.x > 900) { state.nextPos.x = 80; state.nextPos.y += 180; }
    renderNode(node);
    updateHint();
    return node;
  }

  function removeNode(id) {
    // remove connected edges first
    state.edges = state.edges.filter(e => e.fromNode !== id && e.toNode !== id);
    state.nodes = state.nodes.filter(n => n.id !== id);
    const el = document.querySelector(`.gnode[data-id="${id}"]`);
    if (el) el.remove();
    renderEdges();
    updateHint();
    App.onGraphChange();
  }

  function addEdge(fromNode, toNode, toPort) {
    // avoid duplicate
    if (state.edges.find(e => e.fromNode === fromNode && e.toNode === toNode && e.toPort === toPort)) return;
    // avoid self-loop
    if (fromNode === toNode) return;
    // avoid cycles (simple check)
    if (wouldCycle(fromNode, toNode)) return;

    const wasFirstInput = !state.edges.some(e => e.toNode === toNode);

    const edge = { id: edgeId(), fromNode, fromPort: 0, toNode, toPort: toPort || 0 };
    state.edges.push(edge);

    // If this is the first connection to toNode, rename `line` → source var name in its code
    if (wasFirstInput) {
      const targetNode = state.nodes.find(n => n.id === toNode);
      const srcNode    = state.nodes.find(n => n.id === fromNode);
      if (targetNode && srcNode && !targetNode.isEnd && !targetNode.isGenerator) {
        const varName = toVarName(srcNode.name);
        if (varName !== 'line') {
          // Replace whole-word occurrences of `line` with the new var name
          const updated = targetNode.code.replace(/\bline\b/g, varName);
          if (updated !== targetNode.code) {
            targetNode.code = updated;
            renderNode(targetNode);
          }
        }
      }
    }

    renderEdges();
    App.onGraphChange();
  }

  function removeEdge(id) {
    state.edges = state.edges.filter(e => e.id !== id);
    renderEdges();
    App.onGraphChange();
  }

  function wouldCycle(fromNode, toNode) {
    // DFS from toNode — if we can reach fromNode, adding this edge would create a cycle
    const visited = new Set();
    const stack = [toNode];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === fromNode) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      state.edges.filter(e => e.fromNode === cur).forEach(e => stack.push(e.toNode));
    }
    return false;
  }

  // ── Render single node ─────────────────────────
  function renderNode(node) {
    let el = document.querySelector(`.gnode[data-id="${node.id}"]`);
    if (el) el.remove();

    el = document.createElement('div');
    el.className = 'gnode' + (node.isSource ? ' node-source' : '') + (node.isEnd ? ' node-end' : '');
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top  = node.y + 'px';

    const sourceCount = state.nodes.filter(n => n.isSource).length;
    const canDeleteSource = node.isSource && sourceCount > 1;

    if (node.isGenerator) {
      const canDelete = state.nodes.filter(n => n.isGenerator || n.isSource).length > 1
                     || !state.nodes.some(n => n.isSource);
      el.className = 'gnode node-generator';
      el.innerHTML = `
        <div class="gnode-ports-in"></div>
        <div class="gnode-header">
          <div class="gnode-name">${esc(node.name)}</div>
          <div class="gnode-btns">
            <button class="gnode-btn edit" title="Edit generator code">edit</button>
            ${canDelete ? `<button class="gnode-btn del" title="Remove generator">✕</button>` : ''}
          </div>
        </div>
        <div class="gnode-gen-preview" id="genpreview-${node.id}">
          <span class="gen-preview-loading">…</span>
        </div>
        <div class="gnode-ports-out">${renderOutPort(node)}</div>
      `;
    } else if (node.isSource) {
      // SOURCE node — shows file info + upload button
      const fileInfo = App.getFileInfo(node.fileId);
      const hasFile  = !!fileInfo;
      el.innerHTML = `
        <div class="gnode-ports-in"></div>
        <div class="gnode-header">
          <div class="gnode-name">${esc(node.name)}</div>
          <div class="gnode-btns">
            ${canDeleteSource ? `<button class="gnode-btn del" title="Remove source">✕</button>` : ''}
          </div>
        </div>
        <div class="gnode-source-body">
          ${hasFile
            ? `<div class="source-file-chip">
                 <span class="source-file-icon">◈</span>
                 <span class="source-file-name" title="${esc(fileInfo.name)}">${esc(fileInfo.name)}</span>
                 <span class="source-file-size">${esc(fmtBytes(fileInfo.size))}</span>
                 <button class="source-file-remove" title="Remove file">✕</button>
               </div>`
            : `<div class="source-dropzone" title="Click or drop file to upload">
                 <span class="source-drop-icon">↑</span>
                 <span>drop file or <span class="source-browse-link">browse</span></span>
               </div>`
          }
        </div>
        <div class="gnode-ports-out">${renderOutPort(node)}</div>
      `;
    } else if (node.isEnd) {
      el.innerHTML = `
        <div class="gnode-ports-in">${renderInPorts(node)}</div>
        <div class="gnode-header">
          <div class="gnode-name">${esc(node.name)}</div>
          <div class="gnode-btns"></div>
        </div>
        <div class="gnode-preview">collects all incoming results</div>
        <div class="gnode-ports-out"></div>
      `;
    } else {
      const preview = (node.code.split('\n').find(l => l.trim() && !l.trim().startsWith('//')) || '').trim().substring(0, 50);
      el.innerHTML = `
        <div class="gnode-ports-in">${renderInPorts(node)}</div>
        <div class="gnode-header">
          <div class="gnode-name">${esc(node.name)}</div>
          <div class="gnode-btns">
            <button class="gnode-btn edit">edit</button>
            <button class="gnode-btn del">✕</button>
          </div>
        </div>
        <div class="gnode-preview">${esc(preview)}</div>
        <div class="gnode-ports-out">${renderOutPort(node)}</div>
      `;
    }

    // drag to move
    el.querySelector('.gnode-header').addEventListener('mousedown', (e) => startNodeDrag(e, node, el));

    // edit (regular nodes and generators)
    const editBtn = el.querySelector('.gnode-btn.edit');
    if (editBtn) editBtn.addEventListener('click', (e) => { e.stopPropagation(); App.openEditor(node.id); });

    // delete
    const delBtn = el.querySelector('.gnode-btn.del');
    if (delBtn) delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeNode(node.id); });

    // GENERATOR: load preview
    if (node.isGenerator) {
      fetch('/generator-sample', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: node.code, count: 4 }),
      }).then(r => r.json()).then(d => {
        const prev = document.getElementById(`genpreview-${node.id}`);
        if (!prev) return;
        if (d.error) { prev.innerHTML = `<span class="gen-preview-err">✗ ${esc(d.error)}</span>`; return; }
        prev.innerHTML = d.lines.map(l => `<span class="gen-preview-line">${esc(l)}</span>`).join('') +
          (d.lines.length ? `<span class="gen-preview-more">…</span>` : '');
      }).catch(() => {});
    }

    // SOURCE-specific interactions
    if (node.isSource) {
      const dropzone = el.querySelector('.source-dropzone');
      const browseLink = el.querySelector('.source-browse-link');
      const removeFileBtn = el.querySelector('.source-file-remove');

      if (dropzone) {
        dropzone.addEventListener('click', () => App.triggerSourceUpload(node.id));
        if (browseLink) browseLink.addEventListener('click', (e) => { e.stopPropagation(); App.triggerSourceUpload(node.id); });
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', (e) => {
          e.preventDefault(); dropzone.classList.remove('drag-over');
          if (e.dataTransfer.files[0]) App.uploadFileForSource(node.id, e.dataTransfer.files[0]);
        });
      }
      if (removeFileBtn) {
        removeFileBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          App.clearFileForSource(node.id);
        });
      }
    }

    // port OUT
    const outPort = el.querySelector('.port-out');
    if (outPort) {
      outPort.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); startEdgeDrag(e, node.id); });
      outPort.addEventListener('dblclick', (e) => {
        e.stopPropagation(); e.preventDefault();
        if (!state.edges.some(ed => ed.fromNode === node.id)) openLibraryForAutoConnect({ fromNode: node.id, fromPort: 0 });
      });
      outPort.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const outEdges = state.edges.filter(ed => ed.fromNode === node.id);
        if (outEdges.length) { outEdges.forEach(ed => { state.edges = state.edges.filter(x => x.id !== ed.id); }); renderEdges(); App.onGraphChange(); }
      });
    }

    // port IN drop target
    el.querySelectorAll('.port-in').forEach((portEl, idx) => {
      portEl.addEventListener('mouseup', (e) => { e.stopPropagation(); if (draggingEdge) finishEdgeDrag(node.id, idx); });
      portEl.addEventListener('mouseenter', () => { if (draggingEdge) portEl.classList.add('drop-target'); });
      portEl.addEventListener('mouseleave', () => portEl.classList.remove('drop-target'));
      portEl.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const inEdges = state.edges.filter(ed => ed.toNode === node.id && (ed.toPort || 0) === idx);
        if (inEdges.length) { inEdges.forEach(ed => { state.edges = state.edges.filter(x => x.id !== ed.id); }); renderEdges(); App.onGraphChange(); }
      });
    });

    // right-click context menu
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showNodeCtx(e, node); });

    canvas.appendChild(el);
  }

  function renderInPorts(node) {
    // Always show at least one input port; more can be added via connections
    // For now 1 port per node; label updates dynamically
    return `<div class="port port-in" data-node="${node.id}" data-port="0" title="Input"></div>`;
  }

  function renderOutPort(node) {
    return `<div class="port port-out" data-node="${node.id}" title="Output — drag to connect"></div>`;
  }

  // ── Node drag (move on canvas) ─────────────────
  function startNodeDrag(e, node, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX - node.x;
    const startY = e.clientY - node.y;

    function onMove(ev) {
      node.x = ev.clientX - startX;
      node.y = ev.clientY - startY;
      el.style.left = node.x + 'px';
      el.style.top  = node.y + 'px';
      renderEdges();
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── Edge drag (connect ports) ───────────────────
  function startEdgeDrag(e, fromNodeId) {
    const cRect = canvas.parentElement.getBoundingClientRect();
    const sx = e.clientX - cRect.left;
    const sy = e.clientY - cRect.top;
    draggingEdge = { fromNode: fromNodeId, startX: sx, startY: sy };
    dragEdge.setAttribute('opacity', '1');

    function onMove(ev) {
      const cx = ev.clientX - cRect.left;
      const cy = ev.clientY - cRect.top;
      const from = getPortPos(fromNodeId, 'out', 0);
      dragEdge.setAttribute('d', bezier(from, { x: cx, y: cy }));
    }
    function onUp(ev) {
      dragEdge.setAttribute('opacity', '0');
      dragEdge.setAttribute('d', '');
      draggingEdge = null;
      document.querySelectorAll('.drop-target').forEach(p => p.classList.remove('drop-target'));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function finishEdgeDrag(toNodeId, toPort) {
    if (!draggingEdge) return;
    addEdge(draggingEdge.fromNode, toNodeId, toPort);
    draggingEdge = null;
    dragEdge.setAttribute('opacity', '0');
  }

  // ── Context menu ────────────────────────────────
  function showNodeCtx(e, node) {
    removeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';

    if (!node.isEnd) {
      const edit = document.createElement('div');
      edit.className = 'ctx-item';
      edit.innerHTML = '<span>✏</span> Edit node';
      edit.addEventListener('click', () => { removeCtxMenu(); App.openEditor(node.id); });
      menu.appendChild(edit);
    }

    const dup = document.createElement('div');
    dup.className = 'ctx-item';
    dup.innerHTML = '<span>⧉</span> Duplicate';
    dup.addEventListener('click', () => {
      removeCtxMenu();
      addNode({ name: node.name + ' copy', code: node.code, x: node.x + 30, y: node.y + 30 });
    });
    menu.appendChild(dup);

    if (!node.isSource && !node.isEnd && !node.isGenerator) {
      del.className = 'ctx-item danger';
      del.innerHTML = '<span>✕</span> Delete node';
      del.addEventListener('click', () => { removeCtxMenu(); removeNode(node.id); });
      menu.appendChild(del);
    }

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 10);
  }

  function removeCtxMenu() {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  }

  // ── Update hint visibility ──────────────────────
  function updateHint() {
    const userNodes = state.nodes.filter(n => !n.isSource && !n.isEnd && !n.isGenerator);
    hint.classList.toggle('hidden', userNodes.length > 0);
  }

  // ── Re-render all ───────────────────────────────
  function renderAll() {
    canvas.innerHTML = '';
    svgGroup.innerHTML = '';
    state.nodes.forEach(renderNode);
    renderEdges();
    updateHint();
  }

  // ── Topological sort (for executor) ─────────────
  function topoSort() {
    const inDeg = {};
    state.nodes.forEach(n => { inDeg[n.id] = 0; });
    state.edges.forEach(e => { inDeg[e.toNode] = (inDeg[e.toNode] || 0) + 1; });

    const queue = state.nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
    const order = [];

    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      state.edges.filter(e => e.fromNode === id).forEach(e => {
        inDeg[e.toNode]--;
        if (inDeg[e.toNode] === 0) queue.push(e.toNode);
      });
    }
    return order;
  }

  // ── Serialise / deserialise ─────────────────────
  function serialise() {
    return {
      nodes: state.nodes.map(n => ({ ...n })),
      edges: state.edges.map(e => ({ ...e })),
      nextId: state.nextId,
    };
  }

  function deserialise(data) {
    state.nodes = data.nodes || [];
    state.edges = data.edges || [];
    state.nextId = data.nextId || (state.nodes.length + 1);
    state.nextPos = { x: 80, y: 80 };
    renderAll();
    updateHint();
  }

  // ── Update a node's name/code in state + re-render
  function updateNode(id, changes) {
    const node = state.nodes.find(n => n.id === id);
    if (!node) return;
    Object.assign(node, changes);
    renderNode(node);   // re-render the card
    renderEdges();      // refresh edge positions
  }

  // ── Library callbacks (set by App after init) ──
  let _pendingAutoConnect = null; // { fromNode, fromPort } | { insertEdgeId }

  function openLibraryForAutoConnect(info) {
    _pendingAutoConnect = { type: 'connect', ...info };
    App.openLibraryForGraph();
  }

  function openLibraryForInsert(edgeId) {
    _pendingAutoConnect = { type: 'insert', edgeId };
    App.openLibraryForGraph();
  }

  /** Called by App after user picks a node from the library */
  function applyPendingConnect(newNode) {
    if (!_pendingAutoConnect) return;
    const p = _pendingAutoConnect;
    _pendingAutoConnect = null;

    if (p.type === 'connect') {
      // Position new node to the right/below the source
      const srcNode = state.nodes.find(n => n.id === p.fromNode);
      if (srcNode) {
        newNode.x = srcNode.x + 260;
        newNode.y = srcNode.y;
        const el = document.querySelector(`.gnode[data-id="${newNode.id}"]`);
        if (el) { el.style.left = newNode.x + 'px'; el.style.top = newNode.y + 'px'; }
      }
      addEdge(p.fromNode, newNode.id, 0);

    } else if (p.type === 'insert') {
      const edge = state.edges.find(e => e.id === p.edgeId);
      if (!edge) return;
      const fromNode = edge.fromNode, toNode = edge.toNode, toPort = edge.toPort || 0;

      // Position new node between source and target
      const srcEl = document.querySelector(`.gnode[data-id="${fromNode}"]`);
      const dstEl = document.querySelector(`.gnode[data-id="${toNode}"]`);
      if (srcEl && dstEl) {
        const sx = parseInt(srcEl.style.left), sy = parseInt(srcEl.style.top);
        const dx = parseInt(dstEl.style.left), dy = parseInt(dstEl.style.top);
        newNode.x = Math.round((sx + dx) / 2);
        newNode.y = Math.round((sy + dy) / 2);
        const el = document.querySelector(`.gnode[data-id="${newNode.id}"]`);
        if (el) { el.style.left = newNode.x + 'px'; el.style.top = newNode.y + 'px'; }
      }

      // Remove old edge, wire source→new and new→target
      state.edges = state.edges.filter(e => e.id !== p.edgeId);
      addEdge(fromNode, newNode.id, 0);
      addEdge(newNode.id, toNode, toPort);
    }
  }

  // ── Public API ───────────────────────────────────
  return {
    state,
    addNode,
    removeNode,
    addEdge,
    removeEdge,
    updateNode,
    renderAll,
    renderEdges,
    renderNode,
    topoSort,
    getInputVarNames,
    toVarName,
    serialise,
    deserialise,
    applyPendingConnect,
    esc,
  };

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
