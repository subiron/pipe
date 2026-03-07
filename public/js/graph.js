/* ═══════════════════════════════════════════════
   PIPE — Graph Engine
   Manages: nodes on canvas, ports, SVG connections
   ═══════════════════════════════════════════════ */

const Graph = (() => {

  // ── State ──────────────────────────────────────
  const state = {
    nodes: [],       // [{ id, name, code, x, y, isSource, isEnd }]
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

  // ── Edge hover dot (HTML div, lives above SVG) ──
  const edgeDot = (() => {
    const dot = document.createElement('div');
    dot.className = 'edge-dot';
    dot.title = 'Click to remove · Double-click to insert node';
    dot.style.display = 'none';
    canvas.parentElement.appendChild(dot);

    let activeEdgeId = null;
    let clickTimer   = null;
    let hideTimer    = null;

    function show(edgeId, x, y) {
      clearTimeout(hideTimer);
      activeEdgeId = edgeId;
      dot.style.left    = x + 'px';
      dot.style.top     = y + 'px';
      dot.style.display = 'block';
    }

    function scheduleHide() {
      hideTimer = setTimeout(() => { dot.style.display = 'none'; activeEdgeId = null; }, 120);
    }

    dot.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    dot.addEventListener('mouseleave', scheduleHide);

    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const eid = activeEdgeId;
      if (!eid) return;
      if (clickTimer) {
        clearTimeout(clickTimer); clickTimer = null;
        dot.style.display = 'none'; activeEdgeId = null;
        openLibraryForInsert(eid);
      } else {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          dot.style.display = 'none'; activeEdgeId = null;
          removeEdge(eid);
        }, 260);
      }
    });

    dot.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const eid = activeEdgeId;
      dot.style.display = 'none'; activeEdgeId = null;
      if (eid) removeEdge(eid);
    });

    return { show, scheduleHide };
  })();

  // ── Draw all SVG edges ──────────────────────────
  function renderEdges() {
    svgGroup.innerHTML = '';
    state.edges.forEach(edge => {
      const from = getPortPos(edge.fromNode, 'out', 0);
      const to   = getPortPos(edge.toNode,   'in',  edge.toPort || 0);
      const d    = bezier(from, to);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'conn-path');
      path.setAttribute('data-edge', edge.id);
      path.setAttribute('d', d);

      // Track mouse position along curve → move the HTML dot
      path.addEventListener('mouseenter', () => path.classList.add('hovered'));
      path.addEventListener('mouseleave', () => {
        path.classList.remove('hovered');
        edgeDot.scheduleHide();
      });
      path.addEventListener('mousemove', (e) => {
        const cRect = canvas.parentElement.getBoundingClientRect();
        edgeDot.show(edge.id, e.clientX - cRect.left, e.clientY - cRect.top);
      });

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
      name:     opts.name     || 'Node',
      code:     opts.code     || 'return line;\n',
      x:        opts.x        !== undefined ? opts.x : state.nextPos.x,
      y:        opts.y        !== undefined ? opts.y : state.nextPos.y,
      isSource: opts.isSource || false,
      isEnd:    opts.isEnd    || false,
    };
    state.nodes.push(node);
    // cascade next position
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
    const edge = { id: edgeId(), fromNode, fromPort: 0, toNode, toPort: toPort || 0 };
    state.edges.push(edge);
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

    const preview = node.isEnd ? 'collects all incoming results'
      : (node.code.split('\n').find(l => l.trim() && !l.trim().startsWith('//')) || '').trim().substring(0, 50);

    el.innerHTML = `
      <div class="gnode-ports-in">${node.isSource ? '' : renderInPorts(node)}</div>
      <div class="gnode-header">
        <div class="gnode-name">${esc(node.name)}</div>
        <div class="gnode-btns">
          ${!node.isEnd ? `<button class="gnode-btn edit">edit</button>` : ''}
          ${!node.isSource && !node.isEnd ? `<button class="gnode-btn del">✕</button>` : ''}
        </div>
      </div>
      <div class="gnode-preview">${esc(preview)}</div>
      <div class="gnode-ports-out">${node.isEnd ? '' : renderOutPort(node)}</div>
    `;

    // drag to move
    const header = el.querySelector('.gnode-header');
    header.addEventListener('mousedown', (e) => startNodeDrag(e, node, el));

    // edit
    const editBtn = el.querySelector('.gnode-btn.edit');
    if (editBtn) editBtn.addEventListener('click', (e) => { e.stopPropagation(); App.openEditor(node.id); });

    // delete
    const delBtn = el.querySelector('.gnode-btn.del');
    if (delBtn) delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeNode(node.id); });

    // port OUT — single mousedown = drag, double-click = open library + auto-connect
    const outPort = el.querySelector('.port-out');
    if (outPort) {
      outPort.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        startEdgeDrag(e, node.id);
      });
      outPort.addEventListener('dblclick', (e) => {
        e.stopPropagation(); e.preventDefault();
        // Only if this port has no outgoing edges
        const hasOut = state.edges.some(ed => ed.fromNode === node.id);
        if (!hasOut) {
          openLibraryForAutoConnect({ fromNode: node.id, fromPort: 0 });
        }
      });
      // Right-click on OUT port → disconnect all outgoing edges
      outPort.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const outEdges = state.edges.filter(ed => ed.fromNode === node.id);
        if (outEdges.length) {
          outEdges.forEach(ed => { state.edges = state.edges.filter(x => x.id !== ed.id); });
          renderEdges(); App.onGraphChange();
        }
      });
    }

    // port IN drop target
    el.querySelectorAll('.port-in').forEach((portEl, idx) => {
      portEl.addEventListener('mouseup', (e) => {
        e.stopPropagation();
        if (draggingEdge) { finishEdgeDrag(node.id, idx); }
      });
      portEl.addEventListener('mouseenter', () => { if (draggingEdge) portEl.classList.add('drop-target'); });
      portEl.addEventListener('mouseleave', () => portEl.classList.remove('drop-target'));
      // Right-click on IN port → disconnect all incoming edges for this port
      portEl.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const inEdges = state.edges.filter(ed => ed.toNode === node.id && (ed.toPort || 0) === idx);
        if (inEdges.length) {
          inEdges.forEach(ed => { state.edges = state.edges.filter(x => x.id !== ed.id); });
          renderEdges(); App.onGraphChange();
        }
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

    if (!node.isSource && !node.isEnd) {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }));
      const del = document.createElement('div');
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
    const userNodes = state.nodes.filter(n => !n.isSource && !n.isEnd);
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
