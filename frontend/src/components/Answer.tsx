import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * The assistant's answer, drawn from its Markdown: bold, bullets, numbered steps, small tables, and ```chart blocks
 * ({"type": "bar" | "line", "title", "unit", "data": [{"label", "value"}]}). Everything renders as React text,
 * never as raw HTML, so nothing in an answer can run in the page.
 */
export function Answer({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /```chart\s*([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Blocks key={`t${last}`} text={text.slice(last, m.index)} />);
    parts.push(<ChartBlock key={`c${m.index}`} raw={m[1]} />);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(<Blocks key={`t${last}`} text={text.slice(last).replace(/```\w*\s*$/, "")} />);
  return <div className="space-y-2">{parts}</div>;
}

function Blocks({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    if (t.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      out.push(<Table key={i} rows={rows} />);
      continue;
    }
    if (/^[-*•]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^[-*•]\s+/, ""));
      out.push(
        <ul key={i} className="list-disc space-y-1 pl-4 marker:text-muted-foreground">
          {items.map((x, k) => (
            <li key={k}>
              <Inline text={x} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^\d+[.)]\s+/, ""));
      out.push(
        <ol key={i} className="list-decimal space-y-1 pl-4 marker:text-muted-foreground">
          {items.map((x, k) => (
            <li key={k}>
              <Inline text={x} />
            </li>
          ))}
        </ol>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(\||[-*•]\s|\d+[.)]\s)/.test(lines[i].trim())) para.push(lines[i++].trim().replace(/^#{1,4}\s+/, "**") + (/^#{1,4}\s+/.test(lines[i - 1]?.trim() ?? "") ? "**" : ""));
    out.push(
      <p key={i}>
        <Inline text={para.join(" ")} />
      </p>,
    );
  }
  return <>{out}</>;
}

/** **bold**, *italic* and `code` inside a line. */
function Inline({ text }: { text: string }) {
  const bits = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).filter(Boolean);
  return (
    <>
      {bits.map((b, k) =>
        b.startsWith("**") && b.endsWith("**") ? (
          <strong key={k} className="font-semibold">
            {b.slice(2, -2)}
          </strong>
        ) : b.startsWith("`") && b.endsWith("`") ? (
          <code key={k} className="rounded bg-background/70 px-1 text-[12px]">
            {b.slice(1, -1)}
          </code>
        ) : b.startsWith("*") && b.endsWith("*") && b.length > 2 ? (
          <em key={k}>{b.slice(1, -1)}</em>
        ) : (
          <span key={k}>{b}</span>
        ),
      )}
    </>
  );
}

function Table({ rows }: { rows: string[][] }) {
  if (!rows.length) return null;
  const [head, ...body] = rows;
  const numeric = (s: string) => /^[−+-]?[\d,.]+\s*(%|pp)?$/.test(s.replace(/\*/g, ""));
  return (
    <div className="overflow-x-auto rounded-lg border bg-background/60">
      <table className="w-full text-[12.5px]">
        <thead className="border-b bg-background/80 text-left text-[11.5px] text-muted-foreground">
          <tr>
            {head.map((h, k) => (
              <th key={k} className="px-2.5 py-1.5 font-semibold">
                <Inline text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {body.map((r, k) => (
            <tr key={k}>
              {r.map((c, j) => (
                <td key={j} className={numeric(c) ? "px-2.5 py-1.5 text-right tabular-nums" : "px-2.5 py-1.5"}>
                  <Inline text={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartBlock({ raw }: { raw: string }) {
  let spec: { type?: string; title?: string; unit?: string; data?: { label: string; value: number }[] };
  try {
    spec = JSON.parse(raw);
  } catch {
    return null;
  }
  const data = (spec.data ?? []).filter((d) => d && typeof d.value === "number").slice(0, 12);
  if (!data.length) return null;
  const unit = spec.unit ?? "";
  const fmt = (v: number) => `${Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)}${unit}`;
  const axis = { stroke: "hsl(var(--muted-foreground))", fontSize: 10.5, tickLine: false, axisLine: false } as const;
  return (
    <figure className="rounded-lg border bg-background/60 p-2.5">
      {spec.title && <figcaption className="mb-1 text-[12px] font-semibold">{spec.title}</figcaption>}
      <div className="h-[170px]">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === "line" ? (
            <LineChart data={data} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} width={40} tickFormatter={fmt} />
              <Tooltip formatter={(v: number) => [fmt(v), spec.title ?? ""]} contentStyle={{ fontSize: 12, borderRadius: 10 }} />
              <Line dataKey="value" stroke="var(--series-ours)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" {...axis} interval={0} tickFormatter={(v: string) => (v.length > 12 ? v.slice(0, 11) + "…" : v)} />
              <YAxis {...axis} width={40} tickFormatter={fmt} />
              <Tooltip formatter={(v: number) => [fmt(v), spec.title ?? ""]} contentStyle={{ fontSize: 12, borderRadius: 10 }} cursor={{ fill: "hsl(var(--muted)/0.5)" }} />
              <Bar dataKey="value" fill="var(--series-ours)" radius={[4, 4, 0, 0]} barSize={18} isAnimationActive={false} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
