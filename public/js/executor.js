/* ═══════════════════════════════════════════════
   PIPE — Graph Executor
   Runs a DAG of nodes over file lines via WebSocket
   ═══════════════════════════════════════════════ */

const Executor = (() => {

  let ws = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen  = () => console.log('[WS] connected');
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = (e) => console.error('[WS]', e);
    ws.onmessage = (evt) => App.onWsMessage(JSON.parse(evt.data));
  }

  function run(fileId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const { nodes, edges } = Graph.state;

    // Build serialisable graph payload
    ws.send(JSON.stringify({
      type:   'process',
      fileId,
      nodes:  nodes.map(n => ({ id: n.id, name: n.name, code: n.code, isSource: n.isSource, isEnd: n.isEnd })),
      edges:  edges.map(e => ({ fromNode: e.fromNode, toNode: e.toNode, toPort: e.toPort || 0 })),
    }));
  }

  return { connect, run };
})();
