# Prisme VQA, Figma plugin

The whole visual QA pipeline inside Figma. No Claude Code, no Python, no MCP, no
local files, no network. Paste a screenshot, select it and the component, compare.

## Why a plugin

The plugin sandbox has the Figma document but no canvas and no image decoding. The
plugin's UI iframe is a real browser context and has both. So the work splits:

- **`code.js`**, main thread. Reads geometry and variable bindings, exports the
  canonical render with `exportAsync`, pulls the pasted screenshot's bytes with
  `getBytesAsync`, and draws the review board.
- **`ui.html`**, iframe. Decodes both PNGs into `ImageData`, diffs, clusters,
  classifies, and sends findings back.

`manifest.json` declares `"allowedDomains": ["none"]`. Nothing leaves Figma, which
matters when asking IT to approve it.

## Install

1. Figma desktop app, Plugins, Development, Import plugin from manifest
2. Pick `manifest.json`
3. It appears under Plugins, Development, Prisme VQA

To share with a team, publish privately to the organisation. No IT approval for new
tooling required, since it is a Figma plugin rather than a local install.

## Use

1. Paste a device screenshot onto the canvas
2. Select the screenshot **and** the component variant it should match
3. Run the plugin, press Compare
4. Press Annotate in Figma to draw markers and a findings panel

The plugin resizes the pasted screenshot from device pixels to logical points on
its own, matching the dimensions against a table of 17 devices.

## How it finds the component

It reads the variant's fill color from the Figma API and scans the screenshot for
that color. That is what removes the need to draw a crop box, and it doubles as
the identity check: if the located element is a different size to the canonical,
these are not the same component.

Height is disqualifying, width is diagnostic. No padding or radius defect changes
height, so a height mismatch aborts. Width moving alone with height steady is the
padding signature, and it says so and continues.

## What it reports

**Token layer**, no image needed. Geometry properties with no variable binding are
a finding before anything is compared.

**Pixel layer.** Cluster shapes map to defect classes:

| Signature | Defect |
| --- | --- |
| Two clusters running the element's full height, at both edges | horizontal padding |
| Four small clusters at the corners, nothing else | corner radius |
| One large cluster, fill ratio above 0.85, mean delta under 40 | hardcoded fill |
| Several scattered clusters over a text run | baseline or letter spacing drift |

The mean delta is what separates the last two from the first two. Geometry defects
run 300 to 500. A hardcoded hex runs around 13 out of 765. Roughly 30x apart, and
completely invisible to the eye.

## Design notes

Four things that were wrong before testing caught them. Worth knowing if you extend
this.

**The canonical must be padded before comparing.** A node export is cropped tight
to the element. Compare at that exact size and an element that grew wider has its
extra width fall outside the window, so the defect is invisible. First test run:
a 6pt padding change reported 0.000% changed.

**Align by the element's center, not its top left.** A component sits centerd in
its container, so symmetric padding growth pushes both edges outward. Aligning by
the left edge collapses that into a right edge change only, and the two-strips
signature never appears. Left-edge alignment gave one cluster. Centre alignment
gives two, one at each edge, which is the readable result.

**Composite the export onto the background before comparing.** Figma node exports
are transparent outside the corner radius. Leaving that as zeroed RGB makes the
corners read as black, which reports as four large false findings on every run.

**The percentage abort gate needs a delta condition.** An entire element being
very slightly the wrong color legitimately covers 46% of the window. Aborting on
area alone would suppress exactly the defect class the tool exists to catch. It
aborts on a lot of area AND a large delta.

## Limits

Untested against a real device screenshot. Every result so far has zero rendering
difference between the two sides, because both images came from the same renderer.
iOS and Android rasterise text differently from Figma, so a correct component will
differ along every glyph edge by some unknown amount. The first thing to run
against a real build is a capture with no defects at all. Whatever that reports is
the noise floor, and the threshold slider goes above it.

Only handles one solid fill per component. A gradient or image fill cannot be
located by color, so those need a different approach.

Full screenshots only. A crop matches no device in the table and is refused rather
than guessed at.
