import { useMemo } from 'react'
import type { VizWidgetProps } from '../../lib/viz/types'

// Escape hatch: render AI-authored HTML in a sandboxed iframe — but force the
// ChalkAI look. We inject the app's design system and STRIP the model's own
// <style>/<head> theming so a generated interactive matches the app instead of
// looking like a generic dark "vibe-coded" page. Scripts + inline geometry are
// preserved so interactions still work.

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">`

const THEME = `<style>
  :root{
    --paper:#e9e4d8; --paper-2:#f5f2ea; --paper-3:#e0dccf; --ink:#2c2823; --ink-soft:#6b6459;
    --clay:#c4694a; --clay-ink:#fbf9f4; --sage:#7e9b82; --yellow:#dcb24a; --navy:#3e4c6b; --red:#c0553c;
    --radius:12px; --radius-sm:8px; --rule:2px; --shadow:0 2px 10px rgba(44,40,35,.08);
    --display:'Bricolage Grotesque',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif; --mono:'JetBrains Mono',ui-monospace,monospace;
  }
  *{box-sizing:border-box}
  /* hard backstop: the page is always warm + light, no matter what the model tried */
  html,body{background:var(--paper) !important; color:var(--ink) !important; margin:0 !important;}
  body{font-family:var(--body); line-height:1.5; padding:18px;}
  h1,h2,h3,h4{font-family:var(--display); font-weight:800; margin:0 0 .35em; letter-spacing:-.01em; color:var(--ink);}
  h1{font-size:1.5rem} h2{font-size:1.2rem} h3{font-size:1.02rem}
  p{margin:.35em 0} a{color:var(--clay)}
  .muted,.sub,.hint{color:var(--ink-soft); font-size:.85rem}
  .label{font-family:var(--mono); font-size:.65rem; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-soft)}

  button,.btn{font-family:var(--body); font-weight:600; font-size:.9rem; cursor:pointer;
    background:var(--clay); color:var(--clay-ink); border:var(--rule) solid var(--ink);
    border-radius:var(--radius-sm); padding:7px 14px; box-shadow:var(--shadow); transition:transform .1s ease, filter .1s ease;}
  button:hover:not(:disabled),.btn:hover{filter:brightness(1.06)}
  button:active:not(:disabled),.btn:active{transform:translateY(1px); box-shadow:none}
  button:disabled{opacity:.4; cursor:not-allowed; box-shadow:none}
  button.secondary,.btn.secondary,button.ghost,.btn.ghost{background:var(--paper-2); color:var(--ink)}
  button.sage,.btn.sage{background:var(--sage); color:var(--ink)}
  button.navy,.btn.navy{background:var(--navy); color:#fff}

  input,select,textarea{font-family:var(--mono); font-size:.9rem; padding:6px 9px;
    border:var(--rule) solid var(--ink); border-radius:var(--radius-sm); background:var(--paper-2); color:var(--ink)}

  .panel,.card{background:var(--paper-2); border:var(--rule) solid var(--ink); border-radius:var(--radius);
    padding:14px; box-shadow:var(--shadow)}
  .row{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
  .col{display:flex; flex-direction:column; gap:10px}
  .center{display:flex; align-items:center; justify-content:center}
  hr{border:none; border-top:var(--rule) solid var(--paper-3); margin:12px 0}

  .chip,.badge,.pill{font-family:var(--mono); font-weight:700; font-size:.8rem; display:inline-block;
    border:var(--rule) solid var(--ink); border-radius:var(--radius-sm); padding:2px 9px; background:var(--paper-2); color:var(--ink)}
  .chip.sage,.badge.sage,.pill.sage{background:var(--sage)} .chip.clay,.badge.clay{background:var(--clay); color:var(--clay-ink)}
  .chip.yellow,.badge.yellow{background:var(--yellow)} .chip.navy,.badge.navy{background:var(--navy); color:#fff}

  /* graph / tree visuals */
  svg{max-width:100%}
  .edge{stroke:var(--ink); stroke-width:2; fill:none; opacity:.45}
  .edge.active{stroke:var(--clay); opacity:1; stroke-width:3}
  .node{fill:var(--paper-2); stroke:var(--ink); stroke-width:2}
  .node.unvisited{fill:var(--paper-2)}
  .node.current,.node.active{fill:var(--yellow)}
  .node.visited,.node.done{fill:var(--sage)}
  .node.onstack,.node.frontier,.node.queued{fill:var(--clay)}
  .node-label,.node text{font-family:var(--mono); font-weight:700; fill:var(--ink); font-size:14px}

  /* array / bar / stack cells */
  .cell{font-family:var(--mono); font-weight:700; border:var(--rule) solid var(--ink); border-radius:var(--radius-sm);
    background:var(--paper-2); color:var(--ink); padding:10px 14px; min-width:38px; text-align:center}
  .cell.active,.cell.current{background:var(--yellow)} .cell.compare{background:var(--clay); color:var(--clay-ink)}
  .cell.sorted,.cell.done{background:var(--sage)}
  .bar{background:var(--ink); border:var(--rule) solid var(--ink); border-radius:4px 4px 0 0}
  .bar.active{background:var(--clay)} .bar.sorted{background:var(--sage)}

  .legend{display:flex; flex-wrap:wrap; gap:12px; align-items:center; font-size:.8rem; color:var(--ink-soft)}
  .legend .dot{display:inline-block; width:12px; height:12px; border-radius:50%; border:2px solid var(--ink); vertical-align:middle; margin-right:5px}

  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-thumb{background:var(--ink-soft); border:3px solid var(--paper); border-radius:99px}
</style>`

function buildDoc(raw: string): string {
  let s = (raw || '').trim()
  // strip any leaked code fences
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim()
  s = s.replace(/<!doctype[^>]*>/gi, '')

  // preserve scripts that may live in a <head>, then drop the head entirely
  let headScripts = ''
  const head = s.match(/<head[^>]*>([\s\S]*?)<\/head>/i)
  if (head) headScripts = (head[1].match(/<script[\s\S]*?<\/script>/gi) || []).join('\n')

  // take the body's inner HTML (or the whole thing if there's no <body>)
  const body = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  let inner = body ? body[1] : s.replace(/<\/?html[^>]*>/gi, '').replace(/<head[\s\S]*?<\/head>/gi, '')

  // remove the model's own <style> — OUR theme governs the look
  inner = inner.replace(/<style[\s\S]*?<\/style>/gi, '')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${FONTS}${THEME}</head><body>${inner}\n${headScripts}</body></html>`
}

export default function CustomWidget({ spec }: VizWidgetProps) {
  const srcDoc = useMemo(() => buildDoc(spec.html || '<p class="muted">No content provided.</p>'), [spec.html])

  return (
    <div className="viz">
      <div className="viz-label">⚡ AI-generated interactive · themed · sandboxed</div>
      <iframe
        title={spec.title || 'AI visualization'}
        sandbox="allow-scripts allow-pointer-lock"
        srcDoc={srcDoc}
        style={{
          flex: 1, minHeight: 0, width: '100%', border: '2px solid var(--color-ink)',
          borderRadius: 'var(--radius)', background: 'var(--color-paper-2)',
        }}
      />
    </div>
  )
}
