# PIPE — Line-by-line File Processing Pipeline

A web application for processing files line by line through a visual node pipeline.

## Features

- 📁 **File upload** — drag & drop or browse
- 🔗 **Visual pipeline** — add, reorder (drag), edit, delete transformation nodes
- ✏️ **JS editor** — write any JavaScript in each node, with live test runner
- ⚡ **Real-time progress** — WebSocket-based live stats
- 💾 **Download output** — get processed file as `.txt`

## Node API

Each node receives:
- `line` — current line string
- `lineNumber` — 1-based line number

Return:
- A string → transformed line passed to next node
- `null` or `undefined` → line is dropped (skipped from output)

## Quick Start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000)

For development with auto-reload:
```bash
npm run dev
```

## Example Transformations

```js
// Trim whitespace
return line.trim();

// Skip empty lines
if (!line.trim()) return null;
return line;

// Extract emails
const match = line.match(/[\w.-]+@[\w.-]+\.\w+/);
return match ? match[0] : null;

// Add line numbers
return `${lineNumber}: ${line}`;

// Filter by prefix
return line.startsWith('#') ? null : line;

// Replace text
return line.replace(/foo/g, 'bar');

// Parse CSV column
return line.split(',')[2];

// Uppercase
return line.toUpperCase();
```

## Tech Stack

- **Backend**: Node.js + Express + ws (WebSocket) + multer
- **Frontend**: Vanilla JS + HTML + CSS (no frameworks)
