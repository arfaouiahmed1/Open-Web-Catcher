import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function DataTable({ title, description, columns, rows }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
      </CardHeader>
      <CardContent className="overflow-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-slate-400">
              {columns.map((column) => (
                <th key={column} className="px-3 py-3 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, index) => (
                <tr key={`${title}-${index}`} className="border-b border-white/5 text-slate-200">
                  {columns.map((column) => (
                    <td key={`${column}-${index}`} className="px-3 py-3 align-top">
                      {typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-3 py-8 text-slate-500" colSpan={columns.length}>
                  No data yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
