/**
 * Analyzes import relationships between all .js files in src/, modules/, and root-level
 * Generates an interactive HTML graph using Cytoscape.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Directories to scan for source files
const SCAN_DIRS = ['src', 'modules'];

// Regex patterns for import/require
const IMPORT_RE = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*(?:from\s*)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Collect all source files
const allFiles = [];
for (const dir of SCAN_DIRS) {
  const fullDir = path.join(ROOT, dir);
  if (!fs.existsSync(fullDir)) continue;
  walkDir(fullDir, fullDir, dir);
}

// Also scan root-level .js and .mjs files
const rootFiles = fs.readdirSync(ROOT).filter(f => /\.(js|mjs)$/.test(f) && f !== 'eslint.config.js');
for (const f of rootFiles) {
  allFiles.push({
    absolute: path.join(ROOT, f),
    relative: f,
    baseDir: '.'
  });
}

function walkDir(dir, baseDir, relativeBase) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      walkDir(fullPath, baseDir, path.join(relativeBase, entry.name));
    } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
      allFiles.push({
        absolute: fullPath,
        relative: path.relative(baseDir, fullPath),
        baseDir: relativeBase
      });
    }
  }
}

// Normalize a relative import path to a key we can look up
function resolveImport(importerFile, importPath) {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null;
  }

  const importerDir = path.dirname(importerFile.absolute);
  let resolved = path.resolve(importerDir, importPath);

  const extensions = ['.js', '.mjs', '/index.js', '/index.mjs'];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    for (const f of allFiles) {
      if (f.absolute === candidate) {
        return f;
      }
    }
  }

  for (const f of allFiles) {
    if (f.absolute === resolved) {
      return f;
    }
  }

  return null;
}

// Build the graph
const nodes = new Map();
const edges = [];
const externalDeps = new Map();

for (const file of allFiles) {
  const label = file.baseDir + '/' + file.relative;
  nodes.set(file.absolute, {
    id: label,
    baseDir: file.baseDir,
    file: file.relative,
    path: file.absolute,
    importCount: 0,
    importedByCount: 0
  });
}

for (const file of allFiles) {
  try {
    const content = fs.readFileSync(file.absolute, 'utf-8');

    const importPaths = new Set();
    let match;

    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      importPaths.add(match[1]);
    }

    REQUIRE_RE.lastIndex = 0;
    while ((match = REQUIRE_RE.exec(content)) !== null) {
      importPaths.add(match[1]);
    }

    DYNAMIC_IMPORT_RE.lastIndex = 0;
    while ((match = DYNAMIC_IMPORT_RE.exec(content)) !== null) {
      importPaths.add(match[1]);
    }

    const sourceNode = nodes.get(file.absolute);
    if (!sourceNode) continue;

    for (const imp of importPaths) {
      const target = resolveImport(file, imp);
      if (target) {
        const targetNode = nodes.get(target.absolute);
        if (targetNode) {
          edges.push({
            source: sourceNode.id,
            target: targetNode.id
          });
          sourceNode.importCount++;
          targetNode.importedByCount++;
        }
      } else if (!imp.startsWith('.')) {
        const pkgName = imp.startsWith('@') ? imp.split('/').slice(0, 2).join('/') : imp.split('/')[0];
        externalDeps.set(pkgName, (externalDeps.get(pkgName) || 0) + 1);
      }
    }
  } catch (e) {
    // Skip files we can't read
  }
}

// Remove isolated nodes
const connectedNodes = new Map();
const connectedIds = new Set();
for (const edge of edges) {
  connectedIds.add(edge.source);
  connectedIds.add(edge.target);
}
for (const [abs, node] of nodes) {
  if (connectedIds.has(node.id)) {
    connectedNodes.set(abs, node);
  }
}

const filteredEdges = edges.filter(e => connectedIds.has(e.source) && connectedIds.has(e.target));

// Group nodes by directory for coloring
const groups = {};
for (const [, node] of connectedNodes) {
  const parts = node.id.split('/');
  const group = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
  if (!groups[group]) groups[group] = [];
  groups[group].push(node);
}

const colors = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F8C471', '#82E0AA', '#F1948A', '#85929E', '#AED6F1',
  '#A3E4D7', '#F9E79F', '#D2B4DE', '#A9CCE3', '#ABEBC6'
];
let colorIdx = 0;
const groupColors = {};
for (const g of Object.keys(groups).sort()) {
  groupColors[g] = colors[colorIdx++ % colors.length];
}

// Prepare data for the HTML
const graphData = {
  nodes: [],
  edges: filteredEdges,
  groups: groupColors,
  externalDeps: [...externalDeps.entries()].sort((a, b) => b[1] - a[1])
};

for (const [, node] of connectedNodes) {
  const parts = node.id.split('/');
  const group = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
  graphData.nodes.push({
    id: node.id,
    label: node.file,
    group: group,
    color: groupColors[group],
    importCount: node.importCount,
    importedByCount: node.importedByCount,
    size: Math.min(30, Math.max(6, Math.log2(node.importCount + node.importedByCount + 1) * 8))
  });
}

// Build HTML content in parts to avoid nested template literals
const graphDataJSON = JSON.stringify(graphData);

function esc(str) {
  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the external deps table rows as plain string
let extDepsRows = '';
for (const [name, count] of graphData.externalDeps.slice(0, 20)) {
  extDepsRows += '<tr><td>' + esc(name) + '</td><td>' + count + '</td></tr>';
}

const HTML_HEAD = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Import Dependency Graph - Agent Society</title>\n<script src="https://unpkg.com/cytoscape@3.28.1/dist/cytoscape.min.js"><\/script>\n<style>\n' +
'* { margin: 0; padding: 0; box-sizing: border-box; }\n' +
'body { font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; background: #1a1a2e; color: #eee; overflow: hidden; height: 100vh; }\n' +
'#cy { width: 100vw; height: 100vh; position: absolute; top: 0; left: 0; }\n' +
'#panel { position: absolute; top: 10px; right: 10px; background: rgba(30,30,60,0.92); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; max-width: 360px; max-height: 90vh; overflow-y: auto; z-index: 100; backdrop-filter: blur(10px); font-size: 13px; }\n' +
'#panel h2 { font-size: 16px; margin-bottom: 12px; color: #fff; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; }\n' +
'#panel h3 { font-size: 14px; margin-top: 16px; color: #ccc; }\n' +
'#legend { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }\n' +
'.legend-item { display: flex; align-items: center; gap: 4px; padding: 2px 8px; background: rgba(255,255,255,0.05); border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap; }\n' +
'.legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }\n' +
'#search { width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #eee; font-size: 13px; margin-bottom: 8px; outline: none; }\n' +
'#search:focus { border-color: #4ECDC4; }\n' +
'#info { font-size: 12px; color: #aaa; margin-top: 8px; }\n' +
'#ext-deps { margin-top: 12px; max-height: 200px; overflow-y: auto; }\n' +
'#ext-deps table { width: 100%; font-size: 11px; border-collapse: collapse; }\n' +
'#ext-deps th, #ext-deps td { padding: 3px 6px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }\n' +
'#ext-deps th { color: #aaa; font-weight: 600; }\n' +
'#ext-deps a { color: #4ECDC4; text-decoration: none; }\n' +
'#ext-deps a:hover { text-decoration: underline; }\n' +
'.tooltip { position: absolute; padding: 8px 12px; background: rgba(0,0,0,0.85); color: #fff; border-radius: 6px; font-size: 12px; pointer-events: none; z-index: 200; display: none; white-space: nowrap; }\n' +
'<\/style>\n<\/head>\n<body>\n' +
'<div id="cy"><\/div>\n' +
'<div id="panel">\n' +
'  <h2>Import \u4F9D\u8D56\u5173\u7CFB\u56FE</h2>\n' +
'  <input type="text" id="search" placeholder="\u641C\u7D22\u6587\u4EF6...">\n' +
'  <div id="info">' + graphData.nodes.length + ' \u4E2A\u8282\u70B9 | ' + graphData.edges.length + ' \u6761\u4F9D\u8D56\u8FB9</div>\n' +
'  <h3>\u6A21\u5757\u5206\u7EC4</h3>\n' +
'  <div id="legend"><\/div>\n' +
'  <h3>\u5916\u90E8\u4F9D\u8D56 Top 20</h3>\n' +
'  <div id="ext-deps">\n' +
'    <table>\n' +
'      <tr><th>\u5305\u540D</th><th>\u5F15\u7528\u6B21\u6570</th><\/tr>\n' +
       extDepsRows +
'    <\/table>\n' +
'  <\/div>\n' +
'<\/div>\n' +
'<div class="tooltip" id="tooltip"><\/div>\n';

const HTML_SCRIPT_START = '<script>\n' +
'var data = ' + graphDataJSON + ';\n' +
'var cy = cytoscape({\n' +
'  container: document.getElementById(\'cy\'),\n' +
'  elements: [\n' +
'    ...data.nodes.map(function(n) { return {\n' +
'      data: { id: n.id, label: n.label, group: n.group, color: n.color, importCount: n.importCount, importedByCount: n.importedByCount, size: n.size }\n' +
'    }}),\n' +
'    ...data.edges.map(function(e, i) { return {\n' +
'      data: { id: \'e\' + i, source: e.source, target: e.target }\n' +
'    }})\n' +
'  ],\n' +
'  style: [\n' +
'    { selector: \'node\', style: {\n' +
'      \'background-color\': \'data(color)\',\n' +
'      \'width\': \'data(size)\',\n' +
'      \'height\': \'data(size)\',\n' +
'      \'label\': \'data(label)\',\n' +
'      \'font-size\': 8,\n' +
'      \'color\': \'#ddd\',\n' +
'      \'text-valign\': \'center\',\n' +
'      \'text-halign\': \'right\',\n' +
'      \'text-margin-x\': 6,\n' +
'      \'border-width\': 1,\n' +
'      \'border-color\': \'rgba(255,255,255,0.15)\',\n' +
'      \'text-outline-color\': \'rgba(0,0,0,0.7)\',\n' +
'      \'text-outline-width\': 1,\n' +
'      \'transition-property\': \'background-color, border-color, width, height\',\n' +
'      \'transition-duration\': 0.2\n' +
'    }},\n' +
'    { selector: \'edge\', style: {\n' +
'      \'width\': 0.8,\n' +
'      \'line-color\': \'rgba(255,255,255,0.08)\',\n' +
'      \'curve-style\': \'bezier\',\n' +
'      \'target-arrow-shape\': \'triangle\',\n' +
'      \'target-arrow-color\': \'rgba(255,255,255,0.2)\',\n' +
'      \'arrow-scale\': 0.5,\n' +
'      \'opacity\': 0.3,\n' +
'      \'transition-property\': \'line-color, opacity, width\',\n' +
'      \'transition-duration\': 0.2\n' +
'    }},\n' +
'    { selector: \'node.highlighted\', style: {\n' +
'      \'background-color\': \'#FFD700\',\n' +
'      \'border-color\': \'#FFA500\',\n' +
'      \'border-width\': 2,\n' +
'      \'text-outline-color\': \'rgba(0,0,0,0.9)\'\n' +
'    }},\n' +
'    { selector: \'node.semi-highlighted\', style: {\n' +
'      \'background-color\': \'data(color)\',\n' +
'      \'border-color\': \'rgba(255,255,255,0.4)\',\n' +
'      \'border-width\': 1.5\n' +
'    }},\n' +
'    { selector: \'node.muted\', style: { \'opacity\': 0.15 }},\n' +
'    { selector: \'edge.highlighted\', style: {\n' +
'      \'line-color\': \'rgba(255,215,0,0.7)\',\n' +
'      \'width\': 2,\n' +
'      \'opacity\': 0.9,\n' +
'      \'target-arrow-color\': \'rgba(255,215,0,0.7)\'\n' +
'    }},\n' +
'    { selector: \'edge.muted\', style: { \'opacity\': 0.03 }}\n' +
'  ],\n' +
'  layout: {\n' +
'    name: \'cose\',\n' +
'    idealEdgeLength: 100,\n' +
'    nodeOverlap: 8,\n' +
'    refresh: 20,\n' +
'    fit: true,\n' +
'    padding: 50,\n' +
'    randomize: false,\n' +
'    componentSpacing: 120,\n' +
'    nodeRepulsion: 6000,\n' +
'    edgeElasticity: 100,\n' +
'    nestingFactor: 2,\n' +
'    gravity: 50,\n' +
'    numIter: 2000,\n' +
'    initialTemp: 200,\n' +
'    coolingFactor: 0.95,\n' +
'    minTemp: 1.0\n' +
'  }\n' +
'});\n' +
'\n' +
'// Legend\n' +
'var legendEl = document.getElementById(\'legend\');\n' +
'var groups = Array.from(new Set(data.nodes.map(function(n) { return n.group; }))).sort();\n' +
'for (var i = 0; i < groups.length; i++) {\n' +
'  var g = groups[i];\n' +
'  var item = document.createElement(\'span\');\n' +
'  item.className = \'legend-item\';\n' +
'  item.innerHTML = \'<span class="legend-dot" style="background:\' + data.groups[g] + \'"><\/span>\' + g;\n' +
'  (function(group) {\n' +
'    item.onclick = function() { highlightGroup(group); };\n' +
'  })(g);\n' +
'  legendEl.appendChild(item);\n' +
'}\n' +
'\n' +
'function highlightGroup(group) {\n' +
'  cy.elements().removeClass(\'highlighted semi-highlighted muted\');\n' +
'  var groupNodes = cy.nodes().filter(function(n) { return n.data(\'group\') === group; });\n' +
'  groupNodes.addClass(\'highlighted\');\n' +
'  cy.nodes().not(groupNodes).addClass(\'muted\');\n' +
'  cy.edges().addClass(\'muted\');\n' +
'}\n' +
'\n' +
'cy.on(\'tap\', function(evt) {\n' +
'  if (evt.target === cy) {\n' +
'    cy.elements().removeClass(\'highlighted semi-highlighted muted\');\n' +
'  }\n' +
'});\n' +
'\n' +
'cy.on(\'mouseover\', \'node\', function(evt) {\n' +
'  var node = evt.target;\n' +
'  var tooltip = document.getElementById(\'tooltip\');\n' +
'  tooltip.style.display = \'block\';\n' +
'  tooltip.innerHTML = \'<strong>\' + node.data(\'label\') + \'<\/strong><br/>\u88AB \' + node.data(\'importedByCount\') + \' \u4E2A\u6587\u4EF6\u5F15\u7528<br/>\u5BFC\u5165\u4E86 \' + node.data(\'importCount\') + \' \u4E2A\u6A21\u5757\';\n' +
'  document.addEventListener(\'mousemove\', moveTooltip);\n' +
'});\n' +
'\n' +
'cy.on(\'mouseout\', \'node\', function() {\n' +
'  document.getElementById(\'tooltip\').style.display = \'none\';\n' +
'  document.removeEventListener(\'mousemove\', moveTooltip);\n' +
'});\n' +
'\n' +
'function moveTooltip(e) {\n' +
'  var t = document.getElementById(\'tooltip\');\n' +
'  t.style.left = (e.clientX + 15) + \'px\';\n' +
'  t.style.top = (e.clientY - 40) + \'px\';\n' +
'}\n' +
'\n' +
'document.getElementById(\'search\').addEventListener(\'input\', function(e) {\n' +
'  var q = e.target.value.toLowerCase();\n' +
'  if (!q) {\n' +
'    cy.elements().removeClass(\'highlighted semi-highlighted muted\');\n' +
'    return;\n' +
'  }\n' +
'  cy.elements().removeClass(\'highlighted semi-highlighted muted\');\n' +
'  var matched = cy.nodes().filter(function(n) { return n.data(\'label\').toLowerCase().indexOf(q) >= 0; });\n' +
'  if (matched.length) {\n' +
'    matched.addClass(\'highlighted\');\n' +
'    var neighbors = matched.closedNeighborhood();\n' +
'    neighbors.filter(\'node\').not(matched).addClass(\'semi-highlighted\');\n' +
'    neighbors.filter(\'edge\').addClass(\'highlighted\');\n' +
'    cy.nodes().not(matched).not(neighbors).addClass(\'muted\');\n' +
'    cy.edges().not(neighbors).addClass(\'muted\');\n' +
'    cy.animate({ center: { eles: matched }, zoom: 0.7, duration: 400 });\n' +
'  }\n' +
'});\n' +
'<\/script>\n' +
'<\/body>\n' +
'<\/html>';

const html = HTML_HEAD + HTML_SCRIPT_START;

const outPath = path.join(ROOT, 'import-graph.html');
fs.writeFileSync(outPath, html);
console.log('Generated: ' + outPath);
console.log('  Nodes: ' + graphData.nodes.length);
console.log('  Edges: ' + graphData.edges.length);
