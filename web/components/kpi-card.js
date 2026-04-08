import { ArrowUpRight } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function KpiCard({ label, value, description, accent = "from-signal/20 to-transparent" }) {
  return (
    <Card className="relative overflow-hidden">
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent}`} />
      <CardHeader className="relative">
        <div>
          <CardDescription>{label}</CardDescription>
          <CardTitle className="mt-2 text-3xl">{value}</CardTitle>
        </div>
        <ArrowUpRight className="h-5 w-5 text-slate-400" />
      </CardHeader>
      <CardContent className="relative pt-0 text-sm text-slate-300">{description}</CardContent>
    </Card>
  );
}
