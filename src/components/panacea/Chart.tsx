import { useMemo } from "react";
import { aggregate, filteredRows, type Table } from "../../lib/panacea/surfaces";
import type { Value } from "../../lib/panacea/atoms";

/** Series colours, from the theme's tokens so every theme draws its own. */
const SERIES = ["var(--accent)", "var(--live)", "var(--warn)", "var(--danger)", "var(--accent-light)", "var(--text-3)"];

const W = 420;
const H = 220;
const PAD = { l: 44, r: 12, t: 12, b: 34 };

const short = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(a < 1 ? 2 : 1);
};

/** Round numbers for an axis from 0 (or the low end) to the top. */
function ticks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/**
 * A chart of a data surface's rows after its filters: bar (grouped), line, area, pie or scatter, drawn as SVG in the
 * theme's colours. Kept small and quiet: a few gridlines, labels that thin out when crowded, a legend only for more
 * than one series.
 */
export function Chart({ table, params, kind, x, y, agg, label }: {
  table: Table;
  params: Record<string, Value>;
  kind: string;
  x: string;
  y: string[];
  agg: string;
  label?: string;
}) {
  const rows = useMemo(() => filteredRows(table, params), [table, params]);
  const data = useMemo(() => (kind === "scatter" ? null : aggregate(table, rows, x, y, agg)), [table, rows, x, y, agg, kind]);
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  if (!rows.length) return <div className="pa-chart-empty">No rows match the filters.</div>;

  if (kind === "scatter") {
    const xi = table.columns.findIndex((c) => c.name === x);
    const yi = table.columns.findIndex((c) => c.name === y[0]);
    const pts = rows.map((r) => [r[xi], r[yi]]).filter((p): p is [number, number] => typeof p[0] === "number" && typeof p[1] === "number").slice(0, 2000);
    if (!pts.length) return <div className="pa-chart-empty">Nothing numeric to plot.</div>;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const xt = ticks(Math.min(...xs), Math.max(...xs));
    const yt = ticks(Math.min(0, ...ys), Math.max(...ys));
    const sx = (v: number) => PAD.l + ((v - xt[0]!) / ((xt.at(-1)! - xt[0]!) || 1)) * iw;
    const sy = (v: number) => PAD.t + ih - ((v - yt[0]!) / ((yt.at(-1)! - yt[0]!) || 1)) * ih;
    return (
      <svg className="pa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label ?? `${y[0]} against ${x}`}>
        {yt.map((t) => <g key={`y${t}`}><line className="pa-grid" x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} /><text className="pa-axis" x={PAD.l - 6} y={sy(t) + 3} textAnchor="end">{short(t)}</text></g>)}
        {xt.map((t) => <text key={`x${t}`} className="pa-axis" x={sx(t)} y={H - PAD.b + 14} textAnchor="middle">{short(t)}</text>)}
        {pts.map((p, i) => <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={2.6} style={{ fill: SERIES[0], fillOpacity: 0.7 }} />)}
        <text className="pa-axis-title" x={W - PAD.r} y={H - 4} textAnchor="end">{x}</text>
      </svg>
    );
  }

  const { labels, series } = data!;
  if (kind === "pie") {
    const vals = series[0]?.values ?? [];
    const total = vals.reduce((a, v) => a + Math.max(0, v), 0) || 1;
    const top = labels.map((l, i) => ({ l, v: Math.max(0, vals[i] ?? 0) })).sort((a, b) => b.v - a.v);
    const shown = top.slice(0, 7);
    const rest = top.slice(7).reduce((a, s) => a + s.v, 0);
    if (rest > 0) shown.push({ l: "Other", v: rest });
    let angle = -Math.PI / 2;
    const cx = 110;
    const cy = H / 2;
    const r = 86;
    return (
      <svg className="pa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label ?? `Share of ${series[0]?.name ?? "rows"} by ${x}`}>
        {shown.map((s, i) => {
          const a = (s.v / total) * Math.PI * 2;
          const a2 = angle + a;
          const large = a > Math.PI ? 1 : 0;
          const d = shown.length === 1
            ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
            : `M ${cx} ${cy} L ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a2)} ${cy + r * Math.sin(a2)} Z`;
          angle = a2;
          return <path key={s.l} d={d} className="pa-slice" style={{ fill: SERIES[i % SERIES.length] }} />;
        })}
        <circle cx={cx} cy={cy} r={r * 0.55} className="pa-hole" />
        {shown.map((s, i) => (
          <g key={`k${s.l}`} transform={`translate(230 ${28 + i * 22})`}>
            <rect width={10} height={10} rx={2} style={{ fill: SERIES[i % SERIES.length] }} />
            <text className="pa-legend" x={16} y={9}>{s.l.slice(0, 18)} · {Math.round((s.v / total) * 100)}%</text>
          </g>
        ))}
      </svg>
    );
  }

  const all = series.flatMap((s) => s.values);
  const yt = ticks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = yt[0]!;
  const hi = yt.at(-1)!;
  const sy = (v: number) => PAD.t + ih - ((v - lo) / ((hi - lo) || 1)) * ih;
  const n = labels.length;
  const band = iw / Math.max(1, n);
  const every = Math.max(1, Math.ceil(n / 8));
  const cx = (i: number) => PAD.l + band * (i + 0.5);
  return (
    <svg className="pa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label ?? `${series.map((s) => s.name).join(", ")} by ${x}`}>
      {yt.map((t) => <g key={`y${t}`}><line className={t === 0 ? "pa-grid is-zero" : "pa-grid"} x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} /><text className="pa-axis" x={PAD.l - 6} y={sy(t) + 3} textAnchor="end">{short(t)}</text></g>)}
      {labels.map((l, i) => (i % every === 0 ? <text key={`x${i}`} className="pa-axis" x={cx(i)} y={H - PAD.b + 14} textAnchor="middle">{l.length > 10 ? `${l.slice(0, 9)}…` : l}</text> : null))}
      {kind === "bar" && series.map((s, si) => {
        const bw = (band * 0.72) / series.length;
        return s.values.map((v, i) => {
          const x0 = PAD.l + band * i + band * 0.14 + bw * si;
          const top = sy(Math.max(0, v));
          const h = Math.abs(sy(v) - sy(0));
          return <rect key={`${si}-${i}`} className="pa-bar" x={x0} y={top} width={Math.max(1, bw - 1)} height={Math.max(0.5, h)} rx={2} style={{ fill: SERIES[si % SERIES.length] }}><title>{`${labels[i]}: ${short(v)}`}</title></rect>;
        });
      })}
      {(kind === "line" || kind === "area") && series.map((s, si) => {
        const pts = s.values.map((v, i) => `${cx(i)},${sy(v)}`).join(" ");
        const colour = SERIES[si % SERIES.length];
        return (
          <g key={s.name}>
            {kind === "area" && <polygon points={`${cx(0)},${sy(0)} ${pts} ${cx(n - 1)},${sy(0)}`} style={{ fill: colour, fillOpacity: 0.18 }} />}
            <polyline points={pts} className="pa-line" style={{ stroke: colour }} />
            {n <= 40 && s.values.map((v, i) => <circle key={i} cx={cx(i)} cy={sy(v)} r={2.4} style={{ fill: colour }}><title>{`${labels[i]}: ${short(v)}`}</title></circle>)}
          </g>
        );
      })}
      {series.length > 1 && series.map((s, si) => (
        <g key={`k${s.name}`} transform={`translate(${PAD.l + si * 110} ${H - 10})`}>
          <rect width={9} height={9} y={-8} rx={2} style={{ fill: SERIES[si % SERIES.length] }} />
          <text className="pa-legend" x={13}>{s.name.slice(0, 14)}</text>
        </g>
      ))}
    </svg>
  );
}

/** The rows of a data surface after its filters, a few columns, as a quiet table. */
export function DataTable({ table, params, columns, limit }: { table: Table; params: Record<string, Value>; columns?: string[]; limit: number }) {
  const rows = useMemo(() => filteredRows(table, params), [table, params]);
  const cols = (columns?.length ? columns : table.columns.map((c) => c.name)).map((n) => table.columns.findIndex((c) => c.name === n)).filter((i) => i >= 0);
  return (
    <div className="pa-table-wrap">
      <table className="pa-table">
        <thead><tr>{cols.map((i) => <th key={i} className={table.columns[i]!.type === "number" ? "is-num" : ""}>{table.columns[i]!.name}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, limit).map((r, ri) => (
            <tr key={ri}>{cols.map((i) => <td key={i} className={typeof r[i] === "number" ? "is-num" : ""}>{typeof r[i] === "number" ? (r[i] as number).toLocaleString() : String(r[i] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <div className="pa-table-foot">{rows.length.toLocaleString()} of {table.rows.length.toLocaleString()} rows{rows.length > limit ? `, first ${limit} shown` : ""}</div>
    </div>
  );
}

/** A chart's SVG with its colours written in, so the file looks the same outside Autora. */
export function standaloneSvg(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const src = svg.querySelectorAll("*");
  copy.querySelectorAll("*").forEach((el, i) => {
    const cs = getComputedStyle(src[i]!);
    const e = el as SVGElement;
    for (const prop of ["fill", "stroke", "fill-opacity", "stroke-width", "font-size", "font-family"] as const) e.style.setProperty(prop, cs.getPropertyValue(prop));
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(W * 2));
  copy.setAttribute("height", String(H * 2));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${copy.outerHTML}`;
}
