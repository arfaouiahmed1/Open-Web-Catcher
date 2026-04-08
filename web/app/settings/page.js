"use client";

import { useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function SettingsPage() {
  const [payload, setPayload] = useState({ stored: [], env_defaults: [] });
  const [provider, setProvider] = useState("google");
  const [modelName, setModelName] = useState("gemini-2.5-flash");
  const [inputPrice, setInputPrice] = useState("0");
  const [outputPrice, setOutputPrice] = useState("0");
  const [notes, setNotes] = useState("");
  const [lastSaved, setLastSaved] = useState(null);

  useEffect(() => {
    async function load() {
      setPayload(await apiFetch("/ui/pricing"));
    }
    load();
  }, [lastSaved]);

  async function savePricing() {
    await fetch(apiUrl("/ui/pricing"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        model_name: modelName,
        input_per_million: Number(inputPrice || 0),
        output_per_million: Number(outputPrice || 0),
        active: true,
        notes
      })
    });
    setLastSaved(Date.now());
  }

  return (
    <div className="space-y-6">
      <section className="max-w-4xl">
        <div className="text-xs uppercase tracking-[0.4em] text-spark">Pricing</div>
        <h1 className="mt-3 text-4xl font-semibold">Own the token economics</h1>
        <p className="mt-4 text-base leading-7 text-slate-300">
          Configure first-party model pricing so the console can compute costs, benchmark cost per success, and surface model-level burn cleanly.
        </p>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Pricing Entry</CardTitle>
              <CardDescription>Override or add a model price row for local cost accounting.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="google" />
            <Input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="gemini-2.5-flash" />
            <Input value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} placeholder="0.00" />
            <Input value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} placeholder="0.00" />
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Operator note about source or billing assumptions." />
            <Button variant="accent" onClick={savePricing}>
              Save pricing row
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Stored Pricing</CardTitle>
              <CardDescription>Operator-managed price rows already persisted in Postgres.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {(payload.stored || []).length ? (
              payload.stored.map((item) => (
                <div key={`${item.provider}-${item.model_name}`} className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                  <div className="font-medium text-white">{item.model_name}</div>
                  <div className="mt-1 text-xs text-slate-500">{item.provider || "unknown provider"}</div>
                  <div className="mt-4 grid gap-2 text-sm text-slate-300 md:grid-cols-2">
                    <div>Input / 1M {formatCurrency(item.input_per_million || 0)}</div>
                    <div>Output / 1M {formatCurrency(item.output_per_million || 0)}</div>
                  </div>
                  {item.notes ? <div className="mt-3 text-sm text-slate-400">{item.notes}</div> : null}
                </div>
              ))
            ) : (
              <div className="rounded-[24px] border border-dashed border-white/10 p-8 text-sm text-slate-500">
                No stored pricing rows yet.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <JsonViewer label="Pricing Payload" value={payload} />
    </div>
  );
}
