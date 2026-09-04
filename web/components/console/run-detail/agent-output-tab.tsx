"use client";

import { Mail, ShieldAlert } from "lucide-react";

import { AgentOutputPanel } from "@/components/agent-output-panel";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface EvidenceRow {
  stream_url?: string;
  protocol?: string;
  server_label?: string;
  channel_name?: string;
  ocr_text?: string;
  screenshot_urls?: string[];
}

interface EmailDraft {
  provider?: string;
  abuse_email?: string;
  stream_urls?: string[];
  stream_evidence?: EvidenceRow[];
  screenshot_urls?: string[];
  server_labels?: string[];
  subject?: string;
  body?: string;
  provider_info?: unknown;
  channel_name?: string;
}

interface EmailDraftCardProps {
  email: EmailDraft;
  index: number;
}

function EmailDraftCard({ email, index }: EmailDraftCardProps): React.JSX.Element {
  const streamCount = Array.isArray(email?.stream_urls) ? email.stream_urls.length : 0;
  const evidenceRows: EvidenceRow[] = Array.isArray(email?.stream_evidence)
    ? (email.stream_evidence as EvidenceRow[])
    : [];
  const screenshotCount = evidenceRows.length
    ? new Set(
        evidenceRows.flatMap((row) =>
          Array.isArray(row?.screenshot_urls) ? row.screenshot_urls.filter(Boolean) : [],
        ),
      ).size
    : Array.isArray(email?.screenshot_urls)
      ? email.screenshot_urls.length
      : 0;
  const serverCount = Array.isArray(email?.server_labels) ? email.server_labels.length : 0;

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="space-y-3 border-b border-border px-4 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
              Draft {index + 1}
            </div>
            <CardTitle className="mt-1 text-sm">
              {email?.provider || "Provider"}{email?.abuse_email ? ` -> ${email.abuse_email}` : ""}
            </CardTitle>
            <CardDescription className="mt-1 text-[12px]">
              Generated from orchestrator provider checks and extraction evidence.
              {email?.channel_name ? ` Channel: ${email.channel_name}.` : ""}
            </CardDescription>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Badge tone="signal" className="font-mono text-[10px]">
              streams {streamCount}
            </Badge>
            <Badge tone="default" className="font-mono text-[10px]">
              screenshots {screenshotCount}
            </Badge>
            <Badge tone="default" className="font-mono text-[10px]">
              servers {serverCount}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 py-4">
        {email?.subject ? (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
              Subject
            </div>
            <div className="mt-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[12px]">
              {email.subject}
            </div>
          </div>
        ) : null}
        {email?.body ? (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
              Email body
            </div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-card px-3 py-3 font-mono text-[11px] leading-relaxed text-foreground/85">
              {email.body}
            </pre>
          </div>
        ) : null}
        {evidenceRows.length ? (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
              Correlated evidence
            </div>
            <div className="mt-2 space-y-3">
              {evidenceRows.map((row, rowIndex) => (
                <div
                  key={`${row?.stream_url || "stream"}-${rowIndex}`}
                  className="rounded-lg border border-border bg-muted/15 px-3 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="signal" className="font-mono text-[10px]">
                      {row?.protocol || "unknown"}
                    </Badge>
                    {row?.server_label ? (
                      <Badge tone="default" className="font-mono text-[10px]">
                        {row.server_label}
                      </Badge>
                    ) : null}
                    {row?.channel_name ? (
                      <Badge tone="default" className="font-mono text-[10px]">
                        {row.channel_name}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-2 break-all font-mono text-[11px] text-foreground/90">
                    {row?.stream_url || "Unknown stream"}
                  </div>
                  {row?.ocr_text ? (
                    <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
                        OCR / visual channel text
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
                        {row.ocr_text}
                      </div>
                    </div>
                  ) : null}
                  {Array.isArray(row?.screenshot_urls) && row.screenshot_urls.length ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {row.screenshot_urls.map((screenshotUrl, screenshotIndex) => (
                        <a
                          key={`${screenshotUrl}-${screenshotIndex}`}
                          href={screenshotUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="overflow-hidden rounded-lg border border-border bg-card transition hover:border-primary/50"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary backend-hosted evidence URL */}
                          <img
                            src={screenshotUrl}
                            alt={`Evidence screenshot ${screenshotIndex + 1}`}
                            className="h-32 w-full object-cover"
                            loading="lazy"
                            decoding="async"
                          />
                          <div className="border-t border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                            Screenshot {screenshotIndex + 1}
                          </div>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {email?.provider_info ? (
          <StructuredDataCard
            title="Provider evidence"
            description="Whois/IPInfo details used by the orchestrator for this draft."
            data={email.provider_info}
            limit={8}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

interface AgentOutputTabProps {
  stageRollups?: unknown[];
  agentRollups?: unknown[];
  parallelism?: unknown;
  takedownEmails?: EmailDraft[];
}

export function AgentOutputTab({
  stageRollups = [],
  agentRollups = [],
  parallelism = null,
  takedownEmails = [],
}: AgentOutputTabProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      <AgentOutputPanel
        stageRollups={stageRollups as never}
        agentRollups={agentRollups as never}
        parallelism={parallelism as never}
        title="Agent outputs"
      />

      <Card className="overflow-hidden shadow-card">
        <CardHeader className="space-y-3 border-b border-border px-4 py-4">
          <div className="flex flex-wrap items-start gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Mail className="h-4 w-4 text-primary" />
                Orchestrator email drafts
              </CardTitle>
              <CardDescription className="mt-0.5 text-sm">
                Takedown emails generated from provider resolution and agent evidence.
              </CardDescription>
            </div>
            <Badge tone={takedownEmails.length ? "signal" : "default"} className="ml-auto font-mono text-[10px]">
              {takedownEmails.length} drafts
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="px-4 py-4">
          {takedownEmails.length ? (
            <div className="space-y-4">
              {takedownEmails.map((email, index) => (
                <EmailDraftCard
                  key={`${email.provider || "provider"}-${email.abuse_email || index}`}
                  email={email}
                  index={index}
                />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              No orchestrator email draft was generated for this run.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
