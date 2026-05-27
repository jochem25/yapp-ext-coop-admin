import { ChevronUp, ChevronDown, ChevronsUpDown, Search } from "lucide-react";

export type SortDir = "asc" | "desc";
export interface SortState { field: string; dir: SortDir }

export function sortRows<T>(rows: T[], sort: SortState | null): T[] {
  if (!sort) return rows;
  const { field, dir } = sort;
  return rows.slice().sort((a, b) => {
    const av = (a as Record<string, unknown>)[field];
    const bv = (b as Record<string, unknown>)[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return dir === "asc" ? av - bv : bv - av;
    }
    const cmp = String(av).localeCompare(String(bv), "nl", { numeric: true, sensitivity: "base" });
    return dir === "asc" ? cmp : -cmp;
  });
}

export function filterRows<T>(rows: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    Object.values(r as Record<string, unknown>).some((v) =>
      v != null && typeof v !== "object" && String(v).toLowerCase().includes(needle)
    )
  );
}

export function sumField<T>(rows: T[], field: string): number {
  return rows.reduce((s, r) => {
    const v = (r as Record<string, unknown>)[field];
    return typeof v === "number" ? s + v : s;
  }, 0);
}

interface SortHeaderProps {
  field: string;
  label: string;
  align?: "left" | "right";
  sort: SortState | null;
  onSort: (s: SortState | null) => void;
  className?: string;
}

export function SortHeader({ field, label, align = "left", sort, onSort, className }: SortHeaderProps) {
  const active = sort?.field === field;
  const dir: SortDir | null = active ? sort!.dir : null;
  const ariaSort: "ascending" | "descending" | "none" =
    dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none";
  const click = () => {
    if (!active) onSort({ field, dir: "asc" });
    else if (dir === "asc") onSort({ field, dir: "desc" });
    else onSort(null);
  };
  return (
    <th
      onClick={click}
      aria-sort={ariaSort}
      className={`${align === "right" ? "text-right" : "text-left"} px-4 py-2 font-semibold text-slate-600 cursor-pointer select-none hover:bg-slate-100 ${className ?? ""}`}
    >
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "w-full justify-end" : ""}`}>
        {label}
        {active ? (
          dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />
        ) : (
          <ChevronsUpDown size={12} className="opacity-30" />
        )}
      </span>
    </th>
  );
}

interface FilterBarProps {
  search: string;
  setSearch: (s: string) => void;
  hasSort: boolean;
  resetSort: () => void;
  totalCount: number;
  visibleCount: number;
  placeholder?: string;
}

export function FilterBar({
  search,
  setSearch,
  hasSort,
  resetSort,
  totalCount,
  visibleCount,
  placeholder = "Filter...",
}: FilterBarProps) {
  const hasSearch = search.trim().length > 0;
  return (
    <div className="px-4 py-2 bg-white border-b border-slate-100 flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
        <Search size={14} className="text-slate-400 shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={placeholder}
          className="flex-1 text-sm px-2 py-1 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
      </div>
      <div className="text-xs text-slate-500">
        {hasSearch ? `${visibleCount} van ${totalCount}` : `${totalCount} ${totalCount === 1 ? "rij" : "rijen"}`}
      </div>
      {(hasSearch || hasSort) && (
        <button
          onClick={() => { setSearch(""); resetSort(); }}
          className="text-xs text-slate-500 hover:text-slate-700 underline"
        >
          Reset
        </button>
      )}
    </div>
  );
}
