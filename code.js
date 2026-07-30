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

  let fill = null, fillBound = null;
  if ("fills" in node && Array.isArray(node.fills)) {
    for (const f of node.fills) {
      if (f.type === "SOLID") { fill = hex(f.color); break; }
    }
  }
  if (bv.fills && bv.fills[0]) {
    const v = await figma.variables.getVariableByIdAsync(bv.fills[0].id);
    fillBound = v ? v.name : null;
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
    cornerRadius: typeof node.cornerRadius === "number" ? node.cornerRadius : null,
    fill: fill,
    fillBound: fillBound,
    bound: bound,
    unbound: unbound
  };
}

// ---------------------------------------------------------------- selection
function classifySelection() {
  const sel = figma.currentPage.selection;
  let shot = null, comp = null;
  for (const n of sel) {
    if (!shot && imageHashOf(n)) { shot = n; continue; }
    if (!comp && (n.type === "COMPONENT" || n.type === "INSTANCE" ||
                  n.type === "FRAME" || n.type === "COMPONENT_SET")) comp = n;
  }
  // a COMPONENT_SET cannot be exported meaningfully, walk to its first child
  if (comp && comp.type === "COMPONENT_SET" && comp.children.length) comp = comp.children[0];
  return { shot, comp };
}

async function collect() {
  const { shot, comp } = classifySelection();
  if (!shot) return { error: "Select the pasted screenshot. It needs an image fill." };
  if (!comp) return { error: "Also select the component variant to compare against." };

  const img = figma.getImageByHash(imageHashOf(shot));
  const size = await img.getSizeAsync();
  const device = matchDevice(size.width, size.height);
  const dpr = device ? device.dpr : null;

  if (!dpr) {
    return { error: "Screenshot is " + size.width + " x " + size.height +
             " px, which matches no known device. A crop rather than a full " +
             "screen will always land here." };
  }

  const spec = await readSpec(comp);
  const shotBytes = await img.getBytesAsync();
  const canonBytes = await comp.exportAsync({
    format: "PNG", constraint: { type: "SCALE", value: dpr }
  });

  return {
    shotBytes: shotBytes,
    canonBytes: canonBytes,
    shotPixels: [size.width, size.height],
    device: device,
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
  if (d && (Math.round(shot.width) !== d.lw || Math.round(shot.height) !== d.lh)) {
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

async function auditVariables() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const vars = await figma.variables.getLocalVariablesAsync();
  const byId = {};
  for (const v of vars) byId[v.id] = v;

  const colById = {};
  for (const c of cols) colById[c.id] = c;

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
  function boundName(n, key) {
    const bv = n.boundVariables || {};
    return bv[key] ? (byId[bv[key].id] ? byId[bv[key].id].name : "?") : null;
  }

  // group by the Size property, or by height when there is no Size axis
  const bySize = {};
  for (const v of variants) {
    const size = prop(v.name, "Size") || ("h" + Math.round(v.height));
    if (!bySize[size]) bySize[size] = [];
    bySize[size].push(v);
  }

  const sizeRows = [];
  for (const size of Object.keys(bySize)) {
    const g = bySize[size];
    const tokens = {}, values = {};
    for (const v of g) {
      const t = boundName(v, "paddingLeft") || "(unbound)";
      tokens[t] = (tokens[t] || 0) + 1;
      values[Math.round(v.paddingLeft)] = (values[Math.round(v.paddingLeft)] || 0) + 1;
    }
    const distinct = Object.keys(tokens);
    sizeRows.push({ size: size, count: g.length, height: g[0].height,
                    tokens: distinct, values: Object.keys(values).map(Number) });

    if (distinct.length > 1) {
      const sorted = distinct.sort((a, b) => tokens[b] - tokens[a]);
      const odd = g.filter(v => (boundName(v, "paddingLeft") || "(unbound)") !== sorted[0]);
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
    const bv = v.boundVariables || {};
    return (v.paddingLeft > 0 && !bv.paddingLeft)
        || (v.itemSpacing > 0 && !bv.itemSpacing)
        || (typeof v.cornerRadius === "number" && v.cornerRadius > 0 && !bv.topLeftRadius);
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

  return { findings: findings, variantCount: variants.length, sizeRows: sizeRows };
}

// ---------------------------------------------------------------- messaging
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "collect") {
      const data = await collect();
      figma.ui.postMessage(Object.assign({ type: "collected" }, data));
    } else if (msg.type === "audit") {
      const res = await auditVariables();
      let setRes = null;
      const sel = figma.currentPage.selection;
      const cs = sel.find(n => n.type === "COMPONENT_SET" || n.type === "COMPONENT");
      if (cs) {
        const root = cs.type === "COMPONENT" && cs.parent &&
                     cs.parent.type === "COMPONENT_SET" ? cs.parent : cs;
        setRes = await auditComponentSet(root);
        setRes.name = root.name;
      }
      figma.ui.postMessage({ type: "audited", variables: res, componentSet: setRes });
    } else if (msg.type === "annotate") {
      const note = await annotate(msg.payload);
      figma.ui.postMessage({ type: "annotated", note: note });
      figma.notify(note);
    }
  } catch (e) {
    figma.ui.postMessage({ type: "collected", error: String(e && e.message || e) });
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
