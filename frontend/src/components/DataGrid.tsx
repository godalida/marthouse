export function DataGrid({ rows, columns }: { rows: Record<string, unknown>[]; columns: string[] }) {
  return (
    <table className="grid">
      <thead><tr><th style={{ width: 40 }} className="c3">#</th>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="c3 n">{i + 1}</td>
            {columns.map((c) => {
              const v = r[c];
              if (v === null || v === undefined) return <td key={c} className="null">null</td>;
              return <td key={c} className={typeof v === "number" ? "n" : ""} title={String(v)}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
