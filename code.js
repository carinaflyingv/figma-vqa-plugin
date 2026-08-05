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
  [1170, 2532, "iPhone 12 / 13 / 14 / 16e", 390, 844, 3],
  [1179, 2556, "iPhone 14 Pro / 15 / 16", 393, 852, 3],
  [1206, 2622, "iPhone 16 / 17 Pro", 402, 874, 3],
  [1242, 2688, "iPhone XS Max / 11 Pro Max", 414, 896, 3],
  [1284, 2778, "iPhone 12 / 13 Pro Max", 428, 926, 3],
  [1290, 2796, "iPhone 15 Pro Max / 16 Plus", 430, 932, 3],
  [1320, 2868, "iPhone 16 / 17 Pro Max", 440, 956, 3],
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
// Padding, spacing and radius may all sit on different nodes than the variant
// root. Fusion puts them on a nested auto layout frame, so reading only the root
// reports 0 and produces findings like "observed -21.5 pt against a spec of 0".
function geometryNode(node) {
  let best = null;
  (function walk(n) {
    if ((n.paddingLeft > 0 || n.paddingRight > 0 || n.itemSpacing > 0) && !best) best = n;
    if ("children" in n && !best) for (const c of n.children) walk(c);
  })(node);
  return best || node;
}

async function readSpec(node) {
  const geo = geometryNode(node);
  const bv = geo.boundVariables || {};
  const bound = {};
  const props = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
                 "itemSpacing"];
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
  if (geo.paddingLeft > 0 && !bound.paddingLeft) unbound.push("paddingLeft");
  if (geo.paddingRight > 0 && !bound.paddingRight) unbound.push("paddingRight");
  if (geo.itemSpacing > 0 && !bound.itemSpacing) unbound.push("itemSpacing");
  if (fill && !fillBound) unbound.push("fill");

  return {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
    paddingLeft: geo.paddingLeft,
    paddingRight: geo.paddingRight,
    paddingTop: geo.paddingTop,
    paddingBottom: geo.paddingBottom,
    itemSpacing: geo.itemSpacing,
    geometryOn: geo !== node ? geo.name : null,
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

// Every solid paint in the component, keyed by hex, with the variable it is bound
// to. Lets a color finding say "#494343, bg/fill/secondary/default" instead of
// just reporting that a hex moved, which is the difference between a finding a
// developer can fix and one they have to go hunting for.
async function paintTokens(node) {
  const out = {};
  async function visit(n) {
    for (const key of ["fills", "strokes"]) {
      const list = n[key];
      if (!Array.isArray(list)) continue;
      const bv = (n.boundVariables && n.boundVariables[key]) || [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p || p.type !== "SOLID" || p.visible === false) continue;
        const h = hex(p.color);
        let token = null;
        if (bv[i] && bv[i].id) {
          const v = await figma.variables.getVariableByIdAsync(bv[i].id).catch(() => null);
          if (v) token = v.name;
        }
        if (!out[h] || (!out[h].token && token)) {
          out[h] = { token: token, layer: n.name, prop: key === "fills" ? "fill" : "stroke" };
        }
      }
    }
    if ("children" in n) for (const c of n.children) await visit(c);
  }
  await visit(node);
  return out;
}

// The component's typography, so a label finding can name what it should be
// rather than only that it renders differently.
function largestText(node) {
  let best = null, area = 0;
  (function walk(n) {
    if (n.type === "TEXT" && n.visible !== false) {
      const a = (n.width || 0) * (n.height || 0);
      if (a > area) { area = a; best = n; }
    }
    if ("children" in n) for (const c of n.children) walk(c);
  })(node);
  return best;
}

async function typeSpec(node) {
  const t = largestText(node);
  if (!t) return null;
  const mixed = figma.mixed;
  const fn = t.fontName !== mixed ? t.fontName : null;
  let styleName = null;
  if (t.textStyleId && t.textStyleId !== mixed) {
    const st = await figma.getStyleByIdAsync(t.textStyleId).catch(() => null);
    if (st) styleName = st.name;
  }
  const bv = t.boundVariables || {};
  async function bound(k) {
    const e = bv[k];
    const ref = Array.isArray(e) ? e[0] : e;
    if (!ref || !ref.id) return null;
    const v = await figma.variables.getVariableByIdAsync(ref.id).catch(() => null);
    return v ? v.name : null;
  }
  const lh = t.lineHeight !== mixed && t.lineHeight ? t.lineHeight : null;
  const ls = t.letterSpacing !== mixed && t.letterSpacing ? t.letterSpacing : null;
  return {
    layer: t.name,
    family: fn ? fn.family : null,
    weight: fn ? fn.style : null,
    size: t.fontSize !== mixed ? t.fontSize : null,
    lineHeight: lh ? (lh.unit === "AUTO" ? "auto"
                     : Math.round(lh.value * 10) / 10 + (lh.unit === "PERCENT" ? "%" : "")) : null,
    letterSpacing: ls ? Math.round(ls.value * 100) / 100 + (ls.unit === "PERCENT" ? "%" : "") : null,
    styleName: styleName,
    sizeToken: await bound("fontSize"),
    familyToken: await bound("fontFamily"),
    weightToken: await bound("fontStyle"),
    colorToken: await bound("fills"),
    color: (function () {
      if (!Array.isArray(t.fills)) return null;
      for (const f of t.fills) if (f.type === "SOLID" && f.visible !== false) return hex(f.color);
      return null;
    })()
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
// top node reports nothing and the whole locate-by-color step gives up. Search
// descendants and take the largest filled one, which is the background rather
// than an icon or a label.
// Find the node carrying the component's background.
//
// "Biggest painted descendant" is not enough. A component property container can
// be full size and carry a paint that is not the background at all, which is how
// this ended up locating a Fusion button by a dark gray that also appears in
// every label on the screen. So score candidates: the root itself wins outright,
// then anything whose bounds match the component's, then size. Anything that is
// not roughly the component's own footprint is rejected.
function findPaintedNode(node, key) {
  const W = node.width || 1, H = node.height || 1;
  let best = null, bestScore = -1;

  (function walk(n, depth) {
    const skip = n.type === "TEXT" || n.type === "VECTOR" || n.type === "LINE" ||
                 n.visible === false || (n.opacity !== undefined && n.opacity < 0.3);
    if (!skip && solidOf(n, key)) {
      const w = n.width || 0, h = n.height || 0;
      const fitsW = Math.abs(w - W) <= Math.max(2, W * 0.08);
      const fitsH = Math.abs(h - H) <= Math.max(2, H * 0.08);
      if (fitsW && fitsH) {
        // prefer shallower nodes: the background sits above the content
        const score = 1000 - depth;
        if (score > bestScore) { bestScore = score; best = n; }
      }
    }
    if ("children" in n) for (const ch of n.children) walk(ch, depth + 1);
  })(node, 0);

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
  // locate-by-color approach needs something to find. So prefer a variant that
  // has a solid fill, then one with a solid stroke, and only then give up.
  if (comp && comp.type === "COMPONENT_SET" && comp.children.length) {
    comp = pickLocatable(comp) || comp.children[0];
  }
  return { shot, comp };
}

function resolveDevice(size, chosen) {
  if (chosen && chosen.responsive) {
    // A web page has no canonical height, so derive it from the capture's own
    // aspect at the stated width rather than asserting one.
    const lw = chosen.lw;
    const dpr = chosen.dpr;
    const lh = Math.round(size.height / dpr);
    const impliedDpr = size.width / lw;
    return { name: chosen.name, lw: lw, lh: lh, dpr: dpr,
             responsive: true,
             mismatch: Math.abs(impliedDpr - dpr) > 0.06
               ? "The capture is " + size.width + " px wide. At " + dpr + "x that " +
                 "is " + (size.width / dpr).toFixed(0) + " logical px, not " + lw +
                 ". Either the breakpoint or the scale is wrong."
               : null };
  }
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
  spec.type = await typeSpec(comp);
  spec.paints = await paintTokens(comp);

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

  const mode = payload.mode || "all";
  const drawable = payload.findings.filter(f => f.bbox);

  // One board per group. Each gets its own copy of the capture so the arrows have
  // room, rather than every finding pointing into the same small component.
  if (mode === "split") {
    const groups = [];
    drawable.forEach(f => { if (groups.indexOf(f.group) < 0) groups.push(f.group); });
    let x = shot.x, made = 0;
    for (let g = 0; g < groups.length; g++) {
      const name = groups[g];
      const subset = payload.findings.filter(f => f.group === name);
      const copy = shot.clone();
      copy.x = x + (g === 0 ? 0 : 0);
      copy.y = shot.y;
      if (g > 0) copy.x = x;
      copy.name = name + " \u00b7 " + shot.name;
      figma.currentPage.appendChild(copy);

      const heading = figma.createText();
      heading.fontName = { family: "Inter", style: "Semi Bold" };
      heading.characters = name.charAt(0).toUpperCase() + name.slice(1) +
                           "  (" + subset.filter(f => f.bbox).length + ")";
      heading.fontSize = 16;
      heading.fills = [{ type: "SOLID", color: INK }];
      heading.x = copy.x; heading.y = copy.y - 30;
      figma.currentPage.appendChild(heading);

      await drawOne(copy, Object.assign({}, payload, {
        findings: subset,
        title: payload.title + "  \u00b7  " + name
      }), name);
      made++;
      x = copy.x + copy.width + 560;
    }
    figma.viewport.scrollAndZoomIntoView(figma.currentPage.children.slice(-6));
    return "drew " + made + " boards, one per group";
  }

  const subset = mode === "all" ? payload.findings
                                : payload.findings.filter(f => f.group === mode);
  return await drawOne(shot, Object.assign({}, payload, { findings: subset }), mode);
}

async function drawOne(shot, payload, tag) {

  const markerName = "VQA markers" + (tag && tag !== "all" ? " \u00b7 " + tag : "");
  figma.currentPage.findChildren(n => n.name === markerName).forEach(n => n.remove());

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

  // Findings that point rather than box get their badges fanned along a row above
  // the element, evenly spaced and wider than the element itself. Stacking them in
  // two columns put eight arrows through the same few points and made the canvas
  // unreadable, which defeats the purpose of pointing at anything.
  const pointers = F.filter(f => f.point && f.bbox);
  const fanIndex = {};
  pointers.forEach((f, k) => { fanIndex[F.indexOf(f)] = k; });
  const fanCount = pointers.length;
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
    let badgeAt = [bx, by];

    // A finding about type or color needs to point at the thing it describes.
    // Place its badge clear of the element and run a leader with an arrowhead
    // into the middle of the region, so the reader's eye lands on the label or
    // the swatch rather than on a box that could be anything.
    const wantsPointer = f.point || Math.abs(bx - x) > 24 || Math.abs(by - y) > 24;
    if (wantsPointer) {
      const tx = f.point ? x + w / 2 : x;
      const ty = f.point ? y + h / 2 : y;
      if (f.point) {
        // fan across a span wider than the element, well clear of its top edge
        const k = fanIndex[i] || 0;
        const elW = shot.width * 0.0 + w;
        const span = Math.max(elW + 80, fanCount * 34);
        const step = fanCount > 1 ? span / (fanCount - 1) : 0;
        bx = x + w / 2 - span / 2 + step * k;
        by = y - 52;
        placed[placed.length - 1] = [bx, by];
        badgeAt = [bx, by];
      }
      const ddx = tx - bx, ddy = ty - by;
      const len = Math.sqrt(ddx * ddx + ddy * ddy);
      const ang = Math.atan2(ddy, ddx);
      const stop = Math.max(0, len - 9);          // leave room for the head

      const line = figma.createLine();
      line.name = "leader " + (i + 1);
      line.x = bx + Math.cos(ang) * 11;
      line.y = by + Math.sin(ang) * 11;
      line.resize(Math.max(1, stop - 11), 0);
      line.rotation = -ang * 180 / Math.PI;
      line.strokes = [{ type: "SOLID", color: MAGENTA }];
      line.strokeWeight = 1;
      figma.currentPage.appendChild(line); marks.push(line);

      const head = figma.createPolygon();
      head.name = "arrow " + (i + 1);
      head.pointCount = 3;
      head.resize(8, 9);
      head.fills = [{ type: "SOLID", color: MAGENTA }];
      head.strokes = [];
      head.x = bx + Math.cos(ang) * stop - 4;
      head.y = by + Math.sin(ang) * stop - 4.5;
      head.rotation = -(ang * 180 / Math.PI + 90);
      figma.currentPage.appendChild(head); marks.push(head);
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

  // ---- redline dimensions ---------------------------------------------------
  // Developers read spacing as a measured gap, not as a highlighted box. Draw the
  // span itself with end ticks and the number on it, plus what it was, so the
  // change is legible without opening the findings panel.
  F.forEach(function (f, i) {
    if (!f.measures) return;
    f.measures.forEach(function (m) {
      const x0 = shot.x + m.from[0] * kx, y0 = shot.y + m.from[1] * ky;
      const x1 = shot.x + m.to[0] * kx,   y1 = shot.y + m.to[1] * ky;
      const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
      const len = Math.sqrt((x1-x0)*(x1-x0) + (y1-y0)*(y1-y0));
      if (len < 2) return;

      const span = figma.createLine();
      span.name = "dim " + m.label;
      span.x = x0; span.y = y0;
      span.resize(len, 0);
      span.rotation = -Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
      span.strokes = [{ type: "SOLID", color: MAGENTA }];
      span.strokeWeight = 1;
      figma.currentPage.appendChild(span); marks.push(span);

      // end ticks, perpendicular to the span
      [[x0, y0], [x1, y1]].forEach(function (p) {
        const t = figma.createLine();
        t.name = "tick";
        if (horizontal) { t.x = p[0]; t.y = p[1] - 5; t.resize(10, 0); t.rotation = -90; }
        else            { t.x = p[0] - 5; t.y = p[1]; t.resize(10, 0); }
        t.strokes = [{ type: "SOLID", color: MAGENTA }];
        t.strokeWeight = 1;
        figma.currentPage.appendChild(t); marks.push(t);
      });

      const lbl = figma.createText();
      lbl.fontName = { family: "Inter", style: "Semi Bold" };
      lbl.characters = m.label;
      lbl.fontSize = 10;
      lbl.fills = [{ type: "SOLID", color: MAGENTA }];
      lbl.textAlignHorizontal = "CENTER";
      lbl.x = (x0 + x1) / 2 - 26; lbl.y = Math.min(y0, y1) - 16;
      lbl.resize(52, 12);
      figma.currentPage.appendChild(lbl); marks.push(lbl);

      if (m.spec) {
        const was = figma.createText();
        was.fontName = { family: "Inter", style: "Regular" };
        was.characters = m.spec;
        was.fontSize = 9;
        was.fills = [{ type: "SOLID", color: SOFT }];
        was.textAlignHorizontal = "CENTER";
        was.x = (x0 + x1) / 2 - 26; was.y = Math.max(y0, y1) + 5;
        was.resize(52, 11);
        figma.currentPage.appendChild(was); marks.push(was);
      }
    });
  });

  let group = null;
  if (marks.length) {
    group = figma.group(marks, figma.currentPage);
    group.name = markerName;
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
  return "annotated " + F.filter(f => f.bbox).length + " findings";
}

// Renumber a board after cards have been deleted.
//
// A plugin cannot watch the document for deletions, so this is a command rather
// than something automatic. It reads whichever finding cards are still present,
// renumbers them from 1, and renumbers the badges to match by pairing them on the
// finding id stored in each layer name.
async function renumber() {
  await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });

  const panels = figma.currentPage.findChildren(n =>
    n.type === "FRAME" && n.name.indexOf("VQA Findings") === 0);
  if (!panels.length) return "No VQA findings panel on this page.";

  let renamed = 0, orphaned = 0;
  for (const panel of panels) {
    const cards = panel.children.filter(c => c.name.indexOf("finding ") === 0);
    // ids survive on the marker layers, so pair by position in the panel
    const kept = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const head = card.findChild(n => n.type === "TEXT");
      if (!head) continue;
      const oldNum = parseInt(head.characters, 10);
      const rest = head.characters.replace(/^\s*\d+\.\s*/, "");
      head.characters = (i + 1) + ".  " + rest;
      card.name = "finding " + (i + 1);
      kept.push({ from: oldNum, to: i + 1 });
      renamed++;
    }

    // matching marker group sits next to this panel
    const tag = panel.name.indexOf("\u00b7") > 0
      ? panel.name.slice(panel.name.lastIndexOf("\u00b7") + 1).trim() : null;
    const groups = figma.currentPage.findChildren(n =>
      n.type === "GROUP" && n.name.indexOf("VQA markers") === 0);
    for (const g of groups) {
      const map = {};
      kept.forEach(k => { map[k.from] = k.to; });
      // badge numbers are TEXT nodes whose whole content is a number
      const nums = g.findAll(n => n.type === "TEXT" && /^\d+$/.test(n.characters));
      for (const t of nums) {
        const was = parseInt(t.characters, 10);
        if (map[was]) t.characters = String(map[was]);
        else { t.opacity = 0.35; orphaned++; }
      }
      // and the layer names carry the number too
      g.findAll(n => /^(marker|badge|leader|arrow) \d+/.test(n.name)).forEach(n => {
        const m = n.name.match(/^(\w+) (\d+)(.*)$/);
        if (m && map[+m[2]]) n.name = m[1] + " " + map[+m[2]] + m[3];
      });
    }
  }

  return "renumbered " + renamed + " findings" +
         (orphaned ? ", dimmed " + orphaned + " markers with no card left" : "");
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
    } else if (msg.type === "renumber") {
      const note = await renumber();
      figma.ui.postMessage({ type: "annotated", note: note });
      figma.notify(note);
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
      type: "collected",
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
