// Prisme VQA, main thread.
//
// Runs in the plugin sandbox, which has the Figma document but no canvas and no
// image decoding. So this half reads the spec, exports the canonical render, and
// hands raw bytes to the UI iframe, which is a real browser context and can do the
// pixel work. Findings come back and get drawn as a review board.
//
// Nothing leaves Figma. No network, no files, no external service.

figma.showUI(__html__, { width: 460, height: 640, themeColors: true });

// pixel dims -> [name, logicalW, logicalH, dpr]
const DEVICES = [
  [750, 1334, "iPhone SE / 8", 375, 667, 2],
  [828, 1792, "iPhone XR / 11", 414, 896, 2],
  [1080, 1920, "Android 1080p", 360, 640, 3],
  [1080, 2340, "Galaxy S24 / S23", 360, 780, 3],
  [1080, 2400, "Pixel 8 / 7", 412, 915, 2.625],
  [1125, 2436, "iPhone X / XS / 11 Pro", 375, 812, 3],
  [1170, 2532, "iPhone 12 / 13 / 14", 390, 844, 3],
  [1179, 2556, "iPhone 15 / 16 / 15 Pro", 393, 852, 3],
  [1206, 2622, "iPhone 16 Pro", 402, 874, 3],
  [1242, 2688, "iPhone XS Max / 11 Pro Max", 414, 896, 3],
  [1284, 2778, "iPhone 12 / 13 Pro Max", 428, 926, 3],
  [1290, 2796, "iPhone 15 / 16 Pro Max", 430, 932, 3],
  [1320, 2868, "iPhone 16 Pro Max", 440, 956, 3],
  [1344, 2992, "Pixel 8 Pro", 448, 998, 3],
  [1488, 2266, "iPad mini", 744, 1133, 2],
  [1640, 2360, "iPad Air 10.9", 820, 1180, 2],
  [2048, 2732, "iPad Pro 12.9", 1024, 1366, 2]
];

function matchDevice(w, h) {
  for (const d of DEVICES) {
    if (w === d[0] && h === d[1]) return { name: d[2], lw: d[3], lh: d[4], dpr: d[5] };
    if (w === d[1] && h === d[0]) return { name: d[2] + " (landscape)", lw: d[4], lh: d[3], dpr: d[5] };
  }
  return null;
}

function imageHashOf(node) {
  if (!("fills" in node) || !Array.isArray(node.fills)) return null;
  for (const f of node.fills) if (f.type === "IMAGE" && f.imageHash) return f.imageHash;
  return null;
}

function hex(c) {
  const p = v => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + p(c.r) + p(c.g) + p(c.b);
}

// ---------------------------------------------------------------- spec reading
async function readSpec(node) {
  const bv = node.boundVariables || {};
  const bound = {};
  const props = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
                 "itemSpacing", "topLeftRadius", "topRightRadius",
                 "bottomLeftRadius", "bottomRightRadius"];
  for (const k of props) {
    if (bv[k]) {
      const v = await figma.variables.getVariableByIdAsync(bv[k].id);
      bound[k] = v ? v.name : null;
    } else {
      bound[k] = null;
    }
  }

  let fill = null, fillBound = null, locateVia = "fill", paintedOn = null;
  let paintNode = findPaintedNode(node, "fills");
  if (paintNode) {
    fill = hex(solidOf(paintNode, "fills"));
    if (paintNode !== node) paintedOn = paintNode.name;
  } else {
    // An outlined button has no fill. Its border is the only thing distinctive
    // enough to find it by, so use that instead and say so.
    paintNode = findPaintedNode(node, "strokes");
    if (paintNode) {
      fill = hex(solidOf(paintNode, "strokes"));
      locateVia = "stroke";
      if (paintNode !== node) paintedOn = paintNode.name;
    }
  }
  const styleNode = paintNode || node;
  if (styleNode.boundVariables && styleNode.boundVariables.fills &&
      styleNode.boundVariables.fills[0]) {
    const fv = await figma.variables.getVariableByIdAsync(
      styleNode.boundVariables.fills[0].id).catch(() => null);
    if (fv) fillBound = fv.name;
  }


  // unbound geometry is a finding before any image is involved
  const unbound = [];
  if (node.paddingLeft > 0 && !bound.paddingLeft) unbound.push("paddingLeft");
  if (node.paddingRight > 0 && !bound.paddingRight) unbound.push("paddingRight");
  if (node.cornerRadius > 0 && !bound.topLeftRadius) unbound.push("cornerRadius");
  if (node.itemSpacing > 0 && !bound.itemSpacing) unbound.push("itemSpacing");
  if (fill && !fillBound) unbound.push("fill");

  return {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
    paddingLeft: node.paddingLeft,
    paddingRight: node.paddingRight,
    paddingTop: node.paddingTop,
    paddingBottom: node.paddingBottom,
    itemSpacing: node.itemSpacing,
    cornerRadius: typeof styleNode.cornerRadius === "number" ? styleNode.cornerRadius
                : (typeof node.cornerRadius === "number" ? node.cornerRadius : null),
    fill: fill,
    fillBound: fillBound,
    locateVia: locateVia,
    paintedOn: paintedOn,
    bound: bound,
    unbound: unbound
  };
}

// ---------------------------------------------------------------- selection
function solidOf(node, key) {
  const list = node[key];
  if (!Array.isArray(list)) return null;
  for (const p of list) if (p.type === "SOLID" && p.visible !== false) return p.color;
  return null;
}

// The visual styling often is not on the variant root. In Fusion the fill,
// radius and padding all live on a nested auto layout frame, so reading only the
// top node reports nothing and the whole locate-by-colour step gives up. Search
// descendants and take the largest filled one, which is the background rather
// than an icon or a label.
function findPaintedNode(node, key) {
  const rootArea = (node.width || 1) * (node.height || 1);
  let best = null, bestArea = 0;
  (function walk(n) {
    // Skip text and vector paint, and skip anything much smaller than the
    // component. A property container or a label fill is not the background, and
    // picking one gives a colour that appears all over the screenshot.
    const skip = n.type === "TEXT" || n.type === "VECTOR" ||
                 n.visible === false || (n.opacity !== undefined && n.opacity < 0.3);
    if (!skip) {
      const c = solidOf(n, key);
      const area = (n.width || 0) * (n.height || 0);
      if (c && area >= rootArea * 0.5 && area > bestArea) { bestArea = area; best = n; }
    }
    if ("children" in n) for (const ch of n.children) walk(ch);
  })(node);
  return best;
}

function pickLocatable(set) {
  let withStroke = null;
  for (const c of set.children) {
    if (c.type !== "COMPONENT") continue;
    if (findPaintedNode(c, "fills")) return c;
    if (!withStroke && findPaintedNode(c, "strokes")) withStroke = c;
  }
  return withStroke;
}

function classifySelection() {
  const sel = figma.currentPage.selection;
  let shot = null, comp = null;
  for (const n of sel) {
    if (!shot && imageHashOf(n)) { shot = n; continue; }
    if (!comp && (n.type === "COMPONENT" || n.type === "INSTANCE" ||
                  n.type === "FRAME" || n.type === "COMPONENT_SET")) comp = n;
  }
  // A component set cannot be compared directly, so walk into it. The first
  // child is often a text only or ghost variant with no fill, and the whole
  // locate-by-colour approach needs something to find. So prefer a variant that
  // has a solid fill, then one with a solid stroke, and only then give up.
  if (comp && comp.type === "COMPONENT_SET" && comp.children.length) {
    comp = pickLocatable(comp) || comp.children[0];
  }
  return { shot, comp };
}

function resolveDevice(size, chosen) {
  if (chosen && chosen.custom) {
    return { name: "custom @" + chosen.dpr + "x", dpr: chosen.dpr,
             lw: Math.round(size.width / chosen.dpr),
             lh: Math.round(size.height / chosen.dpr) };
  }
  if (chosen) return chosen;
  return matchDevice(size.width, size.height);
}

async function collect(chosen) {
  const { shot, comp } = classifySelection();
  if (!shot) return { error: "Select the pasted screenshot. It needs an image fill." };
  if (!comp) return { error: "Also select the component variant to compare against." };

  const img = figma.getImageByHash(imageHashOf(shot));
  const size = await img.getSizeAsync();
  const device = matchDevice(size.width, size.height);
  const spec = await readSpec(comp);

  // Prefer the device table, since it also gives the logical size for the resize
  // step. But a crop, a node export pasted back, or an unlisted device matches
  // nothing, and refusing outright makes the tool unusable outside a full phone
  // capture. So fall back to deriving the ratio from the pasted frame itself and
  // snapping it to a real one. Approximate is fine here: the diff only needs the
  // two images at the same density, not the true device ratio.
  let dpr = device ? device.dpr : null;
  let dprNote = null;
  if (!dpr) {
    const raw = size.width / Math.max(1, shot.width);
    const candidates = [1, 1.5, 2, 2.625, 3, 3.5, 4];
    dpr = candidates.reduce((a, b) =>
      Math.abs(b - raw) < Math.abs(a - raw) ? b : a);
    dprNote = size.width + " x " + size.height + " px matches no device. Derived " +
              dpr + "x from the pasted frame (raw " + raw.toFixed(2) + ").";
  }
  const shotBytes = await img.getBytesAsync();
  const canonBytes = await comp.exportAsync({
    format: "PNG", constraint: { type: "SCALE", value: dpr }
  });

  return {
    shotBytes: shotBytes,
    canonBytes: canonBytes,
    shotPixels: [size.width, size.height],
    device: device,
    dprNote: dprNote,
    dpr: dpr,
    spec: spec,
    shotNodeId: shot.id,
    compNodeId: comp.id
  };
}

// ---------------------------------------------------------------- annotation
const MAGENTA = { r: 1, g: 0, b: 0.43 };
const INK = { r: 0.027, g: 0.118, b: 0.271 };
const SOFT = { r: 0.239, g: 0.353, b: 0.529 };
const PAPER = { r: 1, g: 1, b: 1 };
const RULE = { r: 0.776, g: 0.816, b: 0.890 };

function mkText(s, size, style, color) {
  const t = figma.createText();
  t.fontName = { family: "Inter", style: style };
  t.characters = s;
  t.fontSize = size;
  t.fills = [{ type: "SOLID", color: color }];
  t.layoutAlign = "STRETCH";
  return t;
}

async function annotate(payload) {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });

  const shot = await figma.getNodeByIdAsync(payload.shotNodeId);
  if (!shot) return "screenshot node is gone";

  figma.currentPage.findChildren(n => n.name === "VQA markers").forEach(n => n.remove());

  // resize from device pixels to logical points, once
  const d = payload.device;
  if (d && d.lw && (Math.round(shot.width) !== d.lw || Math.round(shot.height) !== d.lh)) {
    shot.resize(d.lw, d.lh);
    shot.name = d.name + "  \u00b7  " + d.lw + "x" + d.lh + "pt  @" + d.dpr + "x";
  }

  const F = payload.findings;
  const kx = shot.width / payload.logicalShot[0];
  const ky = shot.height / payload.logicalShot[1];

  const marks = [], placed = [];
  F.forEach(function (f, i) {
    if (!f.bbox) return;
    const x = shot.x + f.bbox[0] * kx, y = shot.y + f.bbox[1] * ky;
    const w = Math.max(2, (f.bbox[2] - f.bbox[0]) * kx);
    const h = Math.max(2, (f.bbox[3] - f.bbox[1]) * ky);

    const box = figma.createRectangle();
    box.name = "marker " + (i + 1) + " " + f.id;
    box.x = x - 3; box.y = y - 3; box.resize(w + 6, h + 6);
    box.fills = []; box.strokes = [{ type: "SOLID", color: MAGENTA }];
    box.strokeWeight = 1.5; box.cornerRadius = 3;
    figma.currentPage.appendChild(box); marks.push(box);

    // two findings on one element usually share a corner, so walk for a free spot
    const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    let bx = null, by = null;
    for (let pass = 0; pass < 4 && bx === null; pass++) {
      for (const c of corners) {
        const cx = c[0] - pass * 22, cy = c[1] - pass * 22;
        if (!placed.some(p => Math.abs(p[0] - cx) < 24 && Math.abs(p[1] - cy) < 24)) {
          bx = cx; by = cy; break;
        }
      }
    }
    if (bx === null) { bx = x - (i + 1) * 26; by = y; }
    placed.push([bx, by]);

    if (Math.abs(bx - x) > 24 || Math.abs(by - y) > 24) {
      const line = figma.createLine();
      line.name = "leader " + (i + 1);
      line.x = bx; line.y = by;
      const ddx = x - bx, ddy = y - by;
      line.resize(Math.sqrt(ddx * ddx + ddy * ddy), 0);
      line.rotation = -Math.atan2(ddy, ddx) * 180 / Math.PI;
      line.strokes = [{ type: "SOLID", color: MAGENTA }];
      line.strokeWeight = 1;
      figma.currentPage.appendChild(line); marks.push(line);
    }

    const badge = figma.createEllipse();
    badge.name = "badge " + (i + 1);
    badge.x = bx - 11; badge.y = by - 11; badge.resize(22, 22);
    badge.fills = [{ type: "SOLID", color: MAGENTA }];
    figma.currentPage.appendChild(badge); marks.push(badge);

    const num = figma.createText();
    num.fontName = { family: "Inter", style: "Semi Bold" };
    num.characters = String(i + 1);
    num.fontSize = 11;
    num.fills = [{ type: "SOLID", color: PAPER }];
    num.textAlignHorizontal = "CENTER";
    num.x = bx - 11; num.y = by - 7; num.resize(22, 14);
    figma.currentPage.appendChild(num); marks.push(num);
  });

  let group = null;
  if (marks.length) {
    group = figma.group(marks, figma.currentPage);
    group.name = "VQA markers";
  }

  const panel = figma.createFrame();
  panel.name = "VQA Findings " + payload.title;
  panel.layoutMode = "VERTICAL";
  panel.itemSpacing = 16;
  panel.paddingLeft = panel.paddingRight = 28;
  panel.paddingTop = panel.paddingBottom = 28;
  panel.counterAxisSizingMode = "FIXED";
  panel.primaryAxisSizingMode = "AUTO";
  panel.resize(460, 100);
  panel.cornerRadius = 14;
  panel.fills = [{ type: "SOLID", color: PAPER }];
  panel.strokes = [{ type: "SOLID", color: RULE }];
  panel.strokeWeight = 1;
  panel.x = shot.x + shot.width + 64;
  panel.y = shot.y;

  panel.appendChild(mkText(payload.title, 18, "Semi Bold", INK));
  panel.appendChild(mkText(payload.subtitle, 11, "Regular", SOFT));

  F.forEach(function (f, i) {
    const card = figma.createFrame();
    card.name = "finding " + (i + 1);
    card.layoutMode = "VERTICAL";
    card.itemSpacing = 5;
    card.paddingLeft = card.paddingRight = 16;
    card.paddingTop = card.paddingBottom = 14;
    card.counterAxisSizingMode = "FIXED";
    card.primaryAxisSizingMode = "AUTO";
    card.layoutAlign = "STRETCH";
    card.fills = [{ type: "SOLID", color: PAPER }];
    card.strokes = [{ type: "SOLID", color: RULE }];
    card.strokeWeight = 1;
    card.cornerRadius = 10;
    card.appendChild(mkText((i + 1) + ".  " + f.property, 14, "Semi Bold", INK));
    card.appendChild(mkText(f.layer + "  \u00b7  " + f.severity, 11, "Regular", SOFT));
    card.appendChild(mkText("spec       " + f.spec, 12, "Regular", SOFT));
    card.appendChild(mkText("observed   " + f.observed, 12, "Regular", MAGENTA));
    if (f.evidence) card.appendChild(mkText(f.evidence, 11, "Regular", SOFT));
    panel.appendChild(card);
  });

  figma.currentPage.appendChild(panel);
  const picks = group ? [shot, group, panel] : [shot, panel];
  figma.currentPage.selection = picks;
  figma.viewport.scrollAndZoomIntoView(picks);
  return "annotated " + F.length + " findings";
}

// ---------------------------------------------------------------- token audit
// Everything below reads. Nothing is sent anywhere and nothing is modified.

const STATES = ["default", "hover", "pressed", "active", "focus", "focused",
                "disabled", "selected", "visited", "rest"];

function trailingNumber(name) {
  const m = name.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function stripState(name) {
  const parts = name.split("/");
  const last = parts[parts.length - 1].toLowerCase();
  if (STATES.indexOf(last) >= 0) return { base: parts.slice(0, -1).join("/"), state: last };
  return null;
}

// Seed from whatever the selection actually binds, then follow aliases upward.
// getLocalVariablesAsync only returns variables DEFINED in this file, so in a
// real setup where the design kit consumes a published token library it returns
// component behaviour toggles and none of the colour or spacing tokens. Walking
// the alias graph from the components reaches the library ones, and has the
// bonus of scoping the audit to tokens this component set actually uses.
async function reachableVariables(seedNodes, onProgress) {
  const MAX = 700;   // stop before a very large library becomes a hang
  const BATCH = 40;  // resolve this many at once
  const found = {}, requested = {};
  let queue = [];

  function seedFrom(n) {
    const bv = n.boundVariables || {};
    for (const k of Object.keys(bv)) {
      const entry = bv[k];
      const list = Array.isArray(entry) ? entry : [entry];
      for (const e of list) if (e && e.id && !requested[e.id]) {
        requested[e.id] = 1; queue.push(e.id);
      }
    }
    if ("children" in n) for (const c of n.children) seedFrom(c);
  }
  for (const n of seedNodes) seedFrom(n);

  // Each remote variable is a round trip. Resolving them one at a time through a
  // few hundred alias hops takes minutes and looks like a hang. Batching turns
  // that into seconds.
  let truncated = false;
  while (queue.length) {
    if (Object.keys(found).length >= MAX) { truncated = true; break; }
    const slice = queue.splice(0, BATCH);
    const got = await Promise.all(slice.map(id =>
      figma.variables.getVariableByIdAsync(id).catch(() => null)));
    for (const v of got) {
      if (!v) continue;
      found[v.id] = v;
      for (const modeId of Object.keys(v.valuesByMode)) {
        const val = v.valuesByMode[modeId];
        if (val && val.type === "VARIABLE_ALIAS" && !requested[val.id]) {
          requested[val.id] = 1; queue.push(val.id);
        }
      }
    }
    if (onProgress) onProgress(Object.keys(found).length, queue.length);
  }
  const list = Object.keys(found).map(k => found[k]);
  list.truncated = truncated;
  return list;
}

async function auditVariables(seedNodes) {
  const localCols = await figma.variables.getLocalVariableCollectionsAsync();
  const localVars = await figma.variables.getLocalVariablesAsync();

  let vars = localVars;
  let sourceNote = "local variables only";
  let truncated = false;
  if (seedNodes && seedNodes.length) {
    const reached = await reachableVariables(seedNodes, (done, left) => {
      figma.ui.postMessage({ type: "progress",
        text: "resolved " + done + " variables, " + left + " queued" });
    });
    truncated = !!reached.truncated;
    const seen = {};
    vars = [];
    for (const v of reached.concat(localVars)) {
      if (!seen[v.id]) { seen[v.id] = true; vars.push(v); }
    }
    sourceNote = reached.length + " reached from the selection, " +
                 localVars.length + " local";
  }

  const byId = {};
  for (const v of vars) byId[v.id] = v;

  // collections may be remote, so resolve them individually rather than
  // assuming they appear in the local list
  const colById = {};
  for (const c of localCols) colById[c.id] = c;
  const wanted = {};
  for (const v of vars) if (!colById[v.variableCollectionId]) wanted[v.variableCollectionId] = 1;
  const gotCols = await Promise.all(Object.keys(wanted).map(id =>
    figma.variables.getVariableCollectionByIdAsync(id).catch(() => null)));
  for (const c of gotCols) if (c) colById[c.id] = c;
  const cols = Object.keys(colById).map(k => colById[k]);

  const hexOf = c => {
    const p = v => Math.round(v * 255).toString(16).padStart(2, "0");
    return "#" + p(c.r) + p(c.g) + p(c.b);
  };

  // value per mode, either an alias target name or a literal
  function valuesOf(v) {
    const col = colById[v.variableCollectionId];
    const out = {};
    if (!col) return out;
    for (const m of col.modes) {
      const val = v.valuesByMode[m.modeId];
      if (val === undefined) continue;
      if (val && val.type === "VARIABLE_ALIAS") {
        const t = byId[val.id];
        out[m.name] = { alias: true, id: val.id, name: t ? t.name : "(missing)" };
      } else if (val && typeof val === "object" && "r" in val) {
        out[m.name] = { alias: false, value: hexOf(val) };
      } else {
        out[m.name] = { alias: false, value: String(val) };
      }
    }
    return out;
  }

  const findings = [];

  // --- A. two states resolving to the same thing --------------------------
  // A pressed state aliased to the same token as default has no press feedback.
  // On web a hover state hides it. On a native app, which has no hover, the
  // control simply does not respond.
  const groups = {};
  for (const v of vars) {
    const st = stripState(v.name);
    if (!st) continue;
    if (!groups[st.base]) groups[st.base] = [];
    groups[st.base].push({ v: v, state: st.state, vals: valuesOf(v) });
  }
  for (const base of Object.keys(groups)) {
    const g = groups[base];
    if (g.length < 2) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        const modes = Object.keys(a.vals).filter(m => b.vals[m]);
        if (!modes.length) continue;
        const same = modes.filter(m => {
          const x = a.vals[m], y = b.vals[m];
          return x.alias && y.alias ? x.id === y.id
               : (!x.alias && !y.alias ? x.value === y.value : false);
        });
        if (same.length === modes.length) {
          findings.push({
            rule: "state collision", severity: "major",
            title: base,
            detail: a.state + " and " + b.state + " resolve identically in " +
                    (modes.length === 1 ? "the only mode" : "all " + modes.length + " modes") +
                    " (" + (a.vals[modes[0]].alias ? a.vals[modes[0]].name : a.vals[modes[0]].value) + ")",
            fix: "Point " + b.state + " one rung away from " + a.state + "."
          });
        }
      }
    }
  }

  // --- B. numbered rungs that do not map straight across -------------------
  // A Segment token named 700 that reaches a Global 800 in one mode and a 700 in
  // the others reads as consistent and is not. Anyone using the table will
  // assume straight across.
  for (const v of vars) {
    const n = trailingNumber(v.name);
    if (n === null) continue;
    const vals = valuesOf(v);
    const modes = Object.keys(vals);
    const targets = modes.filter(m => vals[m].alias)
                         .map(m => ({ mode: m, n: trailingNumber(vals[m].name), name: vals[m].name }))
                         .filter(t => t.n !== null);
    if (targets.length < 2) continue;
    const nums = {};
    targets.forEach(t => { nums[t.n] = (nums[t.n] || []).concat(t.mode); });
    const distinct = Object.keys(nums);
    if (distinct.length > 1) {
      findings.push({
        rule: "ladder misalignment", severity: "minor",
        title: v.name,
        detail: distinct.map(k => k + " in " + nums[k].join(", ")).join("  |  ") +
                ". The rung number does not map straight across modes.",
        fix: "Renumber the odd ramp so its rungs line up. Aliases resolve by id, " +
             "so renaming changes no colours."
      });
    }
  }

  // --- C. variables nothing points at --------------------------------------
  const referenced = {};
  for (const v of vars) {
    const vals = valuesOf(v);
    for (const m of Object.keys(vals)) if (vals[m].alias) referenced[vals[m].id] = true;
  }
  const baseCols = cols.filter(c => {
    // a base collection is one whose variables mostly hold literals
    let lit = 0, tot = 0;
    for (const v of vars) {
      if (v.variableCollectionId !== c.id) continue;
      tot++;
      const val = v.valuesByMode[c.modes[0].modeId];
      if (!(val && val.type === "VARIABLE_ALIAS")) lit++;
    }
    return tot > 0 && lit / tot > 0.8;
  }).map(c => c.id);

  const orphans = vars.filter(v => baseCols.indexOf(v.variableCollectionId) >= 0
                                && !referenced[v.id]);
  if (orphans.length) {
    findings.push({
      rule: "unreferenced base tokens", severity: "info",
      title: orphans.length + " base variables nothing aliases",
      detail: orphans.slice(0, 12).map(v => v.name).join(", ") +
              (orphans.length > 12 ? ", and " + (orphans.length - 12) + " more" : ""),
      fix: "Harmless on their own, but an unused rung inside a numbered ramp " +
           "pushes everything above it out of alignment. Worth checking against " +
           "any ladder misalignment above."
    });
  }

  return { findings: findings, variableCount: vars.length,
           truncated: truncated, sourceNote: sourceNote,
           collections: cols.map(c => ({ name: c.name, modes: c.modes.map(m => m.name) })) };
}

// --- D. size ramp consistency across a component set ------------------------
async function auditComponentSet(node) {
  const vars = await figma.variables.getLocalVariablesAsync();
  const byId = {};
  for (const v of vars) byId[v.id] = v;
  const findings = [];

  const variants = [];
  (function walk(n) {
    if (n.type === "COMPONENT") variants.push(n);
    if ("children" in n) for (const c of n.children) walk(c);
  })(node);
  if (!variants.length) return { findings: [], variantCount: 0 };

  function prop(name, key) {
    const m = name.match(new RegExp(key + "=([^,]+)"));
    return m ? m[1].trim() : null;
  }
  // Padding often lives on an inner auto layout frame rather than on the variant
  // itself. Reading only the top node reports 0 and the ramp check finds nothing.
  function layoutHost(n) {
    if (n.layoutMode && n.layoutMode !== "NONE" &&
        (n.paddingLeft > 0 || n.paddingRight > 0)) return n;
    if ("children" in n) {
      for (const c of n.children) {
        const h = layoutHost(c);
        if (h) return h;
      }
    }
    return n;
  }
  async function boundName(n, key) {
    const bv = n.boundVariables || {};
    if (!bv[key]) return null;
    if (byId[bv[key].id]) return byId[bv[key].id].name;
    try {
      const v = await figma.variables.getVariableByIdAsync(bv[key].id);
      return v ? v.name : "?";
    } catch (e) { return "?"; }
  }

  // group by the Size property, or by height when there is no Size axis
  const hosts = {};
  for (const v of variants) hosts[v.id] = layoutHost(v);

  const bySize = {};
  for (const v of variants) {
    const size = prop(v.name, "Size") || prop(v.name, "Prominence") ||
                 ("h" + Math.round(v.height));
    if (!bySize[size]) bySize[size] = [];
    bySize[size].push(v);
  }

  const sizeRows = [];
  for (const size of Object.keys(bySize)) {
    const g = bySize[size];
    const tokens = {}, values = {};
    for (const v of g) {
      const host = hosts[v.id];
      const t = (await boundName(host, "paddingLeft")) || "(unbound)";
      tokens[t] = (tokens[t] || 0) + 1;
      values[Math.round(host.paddingLeft)] = (values[Math.round(host.paddingLeft)] || 0) + 1;
    }
    const distinct = Object.keys(tokens);
    sizeRows.push({ size: size, count: g.length, height: g[0].height,
                    tokens: distinct, values: Object.keys(values).map(Number) });

    if (distinct.length > 1) {
      const sorted = distinct.sort((a, b) => tokens[b] - tokens[a]);
      const odd = [];
      for (const v of g) {
        const t = (await boundName(hosts[v.id], "paddingLeft")) || "(unbound)";
        if (t !== sorted[0]) odd.push(v);
      }
      findings.push({
        rule: "padding inconsistent within a size", severity: "major",
        title: "Size " + size + ": " + distinct.join(" and "),
        detail: sorted[0] + " on " + tokens[sorted[0]] + " variants, the rest on " +
                distinct.filter(t => t !== sorted[0]).join(", ") + ". Odd ones: " +
                odd.slice(0, 6).map(v => v.name.replace(/Size=[^,]+, /, "")).join(" | ") +
                (odd.length > 6 ? ", and " + (odd.length - 6) + " more" : ""),
        fix: "Every variant at one size should use the same padding token, " +
             "regardless of content type."
      });
    }
  }

  // padding should increase with height, and by a consistent step
  const ramp = sizeRows.filter(r => r.values.length === 1)
                       .sort((a, b) => a.height - b.height);
  if (ramp.length >= 3) {
    const steps = [];
    for (let i = 1; i < ramp.length; i++) steps.push(ramp[i].values[0] - ramp[i-1].values[0]);
    const uniq = steps.filter((s, i) => steps.indexOf(s) === i);
    if (uniq.length > 1) {
      findings.push({
        rule: "uneven padding ramp", severity: "minor",
        title: ramp.map(r => r.size + " " + r.values[0]).join("  ->  "),
        detail: "Steps of " + steps.join(", ") + ". A size ramp usually steps by a " +
                "constant amount, so the odd one out is worth a look.",
        fix: "Check which rung skipped a spacing token."
      });
    }
  }

  const unbound = variants.filter(v => {
    const h = hosts[v.id];
    const bv = h.boundVariables || {};
    const rv = v.boundVariables || {};
    return (h.paddingLeft > 0 && !bv.paddingLeft)
        || (h.itemSpacing > 0 && !bv.itemSpacing)
        || (typeof v.cornerRadius === "number" && v.cornerRadius > 0 && !rv.topLeftRadius);
  });
  if (unbound.length) {
    findings.push({
      rule: "unbound geometry", severity: "major",
      title: unbound.length + " of " + variants.length + " variants have raw values",
      detail: unbound.slice(0, 6).map(v => v.name).join(" | ") +
              (unbound.length > 6 ? ", and " + (unbound.length - 6) + " more" : ""),
      fix: "Bind padding, spacing, and radius to variables so the ramp stays " +
           "enforceable."
    });
  }

  return { findings: findings, variantCount: variants.length, sizeRows: sizeRows,
           paddingFoundOn: paddingFoundOn };
}

// ---------------------------------------------------------------- messaging
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "resizeOnly") {
      const { shot } = classifySelection();
      if (!shot) { figma.ui.postMessage({ type: "resized", note: "Select the pasted screenshot first." }); return; }
      const img = figma.getImageByHash(imageHashOf(shot));
      const size = await img.getSizeAsync();
      const d = resolveDevice(size, msg.device);
      if (!d) {
        figma.ui.postMessage({ type: "resized", note: size.width + "x" + size.height +
          " px matches no device. Pick one from the menu or use Custom scale." });
        return;
      }
      shot.resize(d.lw, d.lh);
      shot.name = d.name + "  \u00b7  " + d.lw + "x" + d.lh + "pt  @" + d.dpr + "x";
      figma.viewport.scrollAndZoomIntoView([shot]);
      figma.ui.postMessage({ type: "resized", note: "resized " + size.width + "x" +
        size.height + " px to " + d.lw + "x" + d.lh + " pt (" + d.name + " @" + d.dpr + "x)" });
    } else if (msg.type === "collect") {
      const data = await collect(msg.device);
      figma.ui.postMessage(Object.assign({ type: "collected" }, data));
    } else if (msg.type === "audit") {
      const sel = figma.currentPage.selection;
      const cs = sel.find(n => n.type === "COMPONENT_SET" || n.type === "COMPONENT");
      let root = null;
      if (cs) {
        root = cs.type === "COMPONENT" && cs.parent &&
               cs.parent.type === "COMPONENT_SET" ? cs.parent : cs;
      }
      const res = await auditVariables(root ? [root] : sel);
      let setRes = null;
      if (root) {
        try {
          setRes = await auditComponentSet(root);
          setRes.name = root.name;
        } catch (e) {
          setRes = { findings: [{ rule: "size ramp check failed", severity: "info",
            title: "Could not read the component set",
            detail: String((e && e.message) || e),
            fix: "The variable audit above still ran." }],
            variantCount: 0, sizeRows: [], name: root.name };
        }
      }
      figma.ui.postMessage({ type: "audited", variables: res, componentSet: setRes });
    } else if (msg.type === "annotate") {
      const note = await annotate(msg.payload);
      figma.ui.postMessage({ type: "annotated", note: note });
      figma.notify(note);
    }
  } catch (e) {
    // Route the error back to the pane that asked, or it lands in a hidden tab
    // and the user sees a blank panel with no explanation.
    const detail = String((e && e.message) || e) +
                   ((e && e.stack) ? "\n" + String(e.stack).split("\n")[1] : "");
    figma.ui.postMessage({
      type: msg.type === "audit" ? "audit_error" : "collected",
      error: detail
    });
  }
};

figma.on("selectionchange", () => {
  const { shot, comp } = classifySelection();
  figma.ui.postMessage({
    type: "selection",
    shot: shot ? shot.name : null,
    comp: comp ? comp.name : null
  });
});
