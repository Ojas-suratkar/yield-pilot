import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Lock, Search, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@yield/core";
import { Button } from "@yield/core/ui/button";
import { Checkbox } from "@yield/core/ui/checkbox";
import { API, type Project } from "../lib/api";
import { can, useSession } from "../lib/auth";
import { projectStore, rowsKey } from "../lib/project";
import { fetchQuery, peekQuery } from "../lib/query";

const CHUNK = 200;
type Row = Record<string, string | null> & { _row: number };
/** Columns the forecast can't work without (term, outcome, ID, admit status, student type, college) can't be removed. */
const ESSENTIAL = ["term", "outcome", "studentId", "admitStatus", "studentType", "college"] as const;

/**
 * The stored dataset, paged from the server and scrolling both ways inside its own frame. Sort by any column, filter
 * on any column, tick rows to delete them, use × on a column to remove it, double-click a value to fix it. Changes
 * show at once and save a new dataset version, so every change can be undone. `_row` is each row's position in the
 * data, so edits hit the right row whatever the sort or filter.
 */
export function DataGrid({ p, highlight = {} }: { p: Project; highlight?: Record<string, string> }) {
  const canEdit = can(useSession().me, "data_manager"); // others can look through the data, not change it
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ row: number; col: string; value: string } | null>(null);
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [filter, setFilter] = useState({ col: "", q: "" });
  const [typed, setTyped] = useState("");
  const version = `${p.dataset?.id}:${p.dataset?.version}`;
  const view = { sort: sort?.key, desc: sort?.desc, col: filter.q ? filter.col : undefined, q: filter.q || undefined };
  const viewKey = JSON.stringify(view);
  const needed = new Set(ESSENTIAL.map((k) => p.mapping[k]).filter(Boolean));

  const page = useCallback(
    async (offset: number) => {
      setBusy(true);
      try {
        // the plain first page is cached (and prefetched) per data version, so the preview appears instantly
        const plain = !view.sort && !view.q;
        const r = offset || !plain ? await API.rows(p.id, offset, CHUNK, view) : await fetchQuery(rowsKey(p), () => API.rows(p.id, 0, CHUNK));
        setRows((prev) => (offset ? [...prev, ...(r.rows as Row[])] : (r.rows as Row[])));
        setColumns(r.columns);
        setTotal(r.total);
        setCanUndo(r.can_undo);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [p.id, version, viewKey], // eslint-disable-line react-hooks/exhaustive-deps -- a new version or view reads its own rows
  );

  useEffect(() => {
    setSelected(new Set());
    if (!view.sort && !view.q) {
      const cached = peekQuery<Awaited<ReturnType<typeof API.rows>>>(rowsKey(p));
      if (cached) {
        setRows(cached.rows as Row[]);
        setColumns(cached.columns);
        setTotal(cached.total);
        setCanUndo(cached.can_undo);
      }
    }
    void page(0);
  }, [version, viewKey, page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => ({ ...f, q: typed.trim() })), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const run = async (op: Promise<Project>, done?: string) => {
    try {
      projectStore.set(await op); // the new version reloads the preview from the server
      if (done) toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
      void page(0); // put back what the server still has
    }
  };
  const deleteRows = () => {
    const n = selected.size;
    const gone = new Set(selected);
    setRows((r) => r.filter((x) => !gone.has(x._row))); // shown at once; saved in the background
    setTotal((t) => t - n);
    setSelected(new Set());
    void run(API.edit(p.id, { op: "delete_rows", rows: [...gone] }), `Deleted ${n} row${n === 1 ? "" : "s"}`);
  };
  const deleteColumn = (c: string) => {
    setColumns((cs) => cs.filter((x) => x !== c));
    void run(API.edit(p.id, { op: "delete_columns", columns: [c] }), `Removed ${c}`);
  };
  const save = () => {
    const was = rows.find((x) => x._row === editing?.row)?.[editing?.col ?? ""] ?? "";
    if (editing && was !== editing.value) {
      setRows((rs) => rs.map((x) => (x._row === editing.row ? { ...x, [editing.col]: editing.value } : x)));
      void run(API.edit(p.id, { op: "edit_cell", row: editing.row, column: editing.col, value: editing.value }));
    }
    setEditing(null);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-2 flex min-h-8 shrink-0 flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {total.toLocaleString()} rows{filter.q ? " match" : ""}, {columns.length} columns
        </span>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <div className="flex items-center gap-1.5">
          <select
            value={filter.col}
            onChange={(e) => setFilter((f) => ({ ...f, col: e.target.value }))}
            className="h-8 max-w-[180px] rounded-full border border-input bg-background px-3 text-[12.5px] outline-none"
            aria-label="Column to filter"
          >
            <option value="">Filter a column…</option>
            {columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          {filter.col && (
            <div className="relative w-44">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={`${filter.col} contains…`}
                className="h-8 w-full rounded-full border border-input bg-background pl-8 pr-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          )}
          {(filter.col || sort) && (
            <Button variant="ghost" size="sm" className="h-8" onClick={() => (setFilter({ col: "", q: "" }), setTyped(""), setSort(null))}>
              Clear
            </Button>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          {selected.size > 0 && (
            <Button variant="outline" size="sm" className="border-destructive/40 text-destructive hover:bg-destructive/5" onClick={deleteRows}>
              <Trash2 /> Delete {selected.size} row{selected.size === 1 ? "" : "s"}
            </Button>
          )}
          {canUndo && (
            <Button variant="ghost" size="sm" onClick={() => void run(API.undo(p.id))}>
              <Undo2 /> Undo
            </Button>
          )}
        </div>
      </div>

      <div
        className="scrollbars-visible min-h-[65vh] w-full flex-1 overflow-auto rounded-[var(--radius-input)] border bg-card"
        tabIndex={0}
        aria-label="Your data. Scroll down and sideways to see everything."
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!busy && rows.length < total && el.scrollTop + el.clientHeight > el.scrollHeight - 400) void page(rows.length);
        }}
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13px] tabular-nums">
          <thead>
            <tr>
              {canEdit && <th className="sticky left-0 top-0 z-30 w-12 border-b border-r bg-muted px-3 py-2.5" />}
              {columns.map((c) => {
                const on = sort?.key === c;
                const Icon = !on ? ArrowUpDown : sort!.desc ? ArrowDown : ArrowUp;
                return (
                  <th key={c} className="sticky top-0 z-20 whitespace-nowrap border-b bg-muted px-3 py-2.5 text-left font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      <button
                        onClick={() => setSort(on ? (sort!.desc ? { key: c, desc: false } : null) : { key: c, desc: true })}
                        className={cn("inline-flex items-center gap-1 hover:text-primary", highlight[c] && "text-primary")}
                        title="Sort by this column"
                      >
                        {c}
                        <Icon className={cn("h-3 w-3", !on && "opacity-40")} />
                      </button>
                      {highlight[c] && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{highlight[c]}</span>}
                      {(needed.has(c) || c === p.dataset?.id_column) && (
                        <span title="The forecast needs this column, so it can't be removed" className="text-muted-foreground/50">
                          <Lock className="h-3 w-3" />
                        </span>
                      )}
                      {canEdit && !highlight[c] && !needed.has(c) && c !== p.dataset?.id_column && (
                        <button
                          onClick={() => deleteColumn(c)}
                          className="rounded p-0.5 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Remove column ${c}`}
                          title="Remove this column"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const on = selected.has(r._row);
              return (
                <tr key={r._row} className={on ? "bg-primary/5" : "hover:bg-muted/40"}>
                  {canEdit && (
                  <td className={cn("sticky left-0 z-10 border-b border-r px-3 py-2", on ? "bg-secondary" : "bg-card")}>
                    <Checkbox
                      checked={on}
                      onCheckedChange={(v) =>
                        setSelected((s) => {
                          const x = new Set(s);
                          if (v) x.add(r._row);
                          else x.delete(r._row);
                          return x;
                        })
                      }
                      aria-label={`Select row ${r._row + 1}`}
                    />
                  </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c}
                      onDoubleClick={() => canEdit && c !== p.dataset?.id_column && setEditing({ row: r._row, col: c, value: r[c] ?? "" })}
                      className={cn("cursor-text whitespace-nowrap border-b px-3 py-2", highlight[c] && "bg-primary/[0.04]")}
                    >
                      {editing?.row === r._row && editing.col === c ? (
                        <input
                          autoFocus
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onBlur={save}
                          onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" ? setEditing(null) : undefined)}
                          className="w-full min-w-[110px] rounded border border-primary bg-background px-1.5 py-0.5 outline-none"
                        />
                      ) : r[c] ? (
                        r[c]
                      ) : (
                        <span className="text-muted-foreground/50">blank</span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {busy && rows.length > 0 && rows.length < total && (
          <div className="flex items-center justify-center gap-2 py-3 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more rows…
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Click a column name to sort.{canEdit && " Tick rows to delete them, use × to remove a column, double-click a value to change it."}
      </p>
    </div>
  );
}
