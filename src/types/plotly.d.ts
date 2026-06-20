// plotly.js-dist-min ships no types; we use a loose surface.
declare module 'plotly.js-dist-min' {
  const Plotly: {
    react: (el: HTMLElement, data: unknown[], layout?: unknown, config?: unknown) => Promise<unknown>
    newPlot: (el: HTMLElement, data: unknown[], layout?: unknown, config?: unknown) => Promise<unknown>
    purge: (el: HTMLElement) => void
    toImage: (el: HTMLElement, opts: { format?: string; width?: number; height?: number }) => Promise<string>
    relayout: (el: HTMLElement, layout: unknown) => Promise<unknown>
    Plots: { resize: (el: HTMLElement) => void }
  }
  export default Plotly
}
