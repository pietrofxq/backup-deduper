import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Database,
  FileSearch,
  Layers,
  Play,
  ShieldCheck,
  Star,
} from 'lucide-react';
import {
  ApiError,
  type DryRunReport,
  type RunRow,
  type ScanStartResponse,
} from '../lib/apiClient.js';
import { useApi } from '../lib/apiContext.js';
import { keys } from '../lib/queryKeys.js';
import { Card, CardBody, CardHeader } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { StatTile } from '../components/StatTile.js';
import { Badge } from '../components/Badge.js';
import { cn } from '../lib/cn.js';
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeTime,
} from '../lib/format.js';

/**
 * Dashboard — the page the user lives on. Top row of stat tiles is the
 * at-a-glance read; below sits the scan CTA + last-scan summary; further
 * down the run history. We keep everything above the fold on a 1280×800
 * desktop window.
 */
export function DashboardPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [scanError, setScanError] = useState<string | null>(null);

  const collections = useQuery({
    queryKey: keys.collections(),
    queryFn: () => api.listCollections(),
  });
  const scans = useQuery({ queryKey: keys.scans(), queryFn: () => api.listScans() });
  const config = useQuery({ queryKey: keys.config(), queryFn: () => api.getConfig() });

  const lastScanId = scans.data?.find((r) => r.kind === 'scan')?.id;
  const lastScan = useQuery({
    queryKey: lastScanId ? keys.scan(lastScanId) : ['scan', 'none'],
    queryFn: () => api.getScan(lastScanId!),
    enabled: lastScanId != null,
  });

  const startScan = useMutation({
    mutationFn: () => api.startScan({}),
    onSuccess: (result: ScanStartResponse) => {
      setScanError(null);
      qc.setQueryData(keys.scan(result.runId), {
        run: { id: result.runId } as Partial<RunRow>,
        report: result.report,
      });
      qc.invalidateQueries({ queryKey: keys.scans() });
      qc.invalidateQueries({ queryKey: keys.collections() });
    },
    onError: (err) => {
      setScanError(err instanceof ApiError ? err.message : 'Scan failed');
    },
  });

  const primary = collections.data?.find((c) => c.isPrimary) ?? null;

  const report = lastScan.data?.report ?? null;

  const totalsHint = useMemo(() => {
    if (!report) return null;
    return `${formatCount(report.totalActions)} actions · ${formatBytes(report.totalBytes)}`;
  }, [report]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Live state of the target_root. Run a scan to refresh."
      />

      <DryRunBanner dryRun={config.data?.dry_run ?? true} />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Collections"
          value={formatCount(collections.data?.length ?? 0)}
          hint={primary ? `primary: ${primary.relPath}` : 'no primary set'}
          icon={<Layers size={14} />}
        />
        <StatTile
          label="Files (last scan)"
          value={
            report ? formatCount(report.scanSummary.totalFiles) : <Skeleton w="3.5rem" />
          }
          hint={
            report
              ? `${formatCount(report.scanSummary.totalHashed)} hashed · ${formatCount(report.scanSummary.totalCached)} cached`
              : 'run a scan'
          }
          icon={<FileSearch size={14} />}
        />
        <StatTile
          label="Bytes touched"
          value={
            report ? formatBytes(report.totalBytes) : <Skeleton w="4rem" />
          }
          hint={totalsHint ?? 'run a scan'}
          icon={<Database size={14} />}
        />
        <StatTile
          label="Last run"
          value={
            scans.data?.[0]
              ? formatRelativeTime(scans.data[0].started_at)
              : 'never'
          }
          hint={
            report ? `${formatDuration(report.scanSummary.durationMs)} elapsed` : '—'
          }
          icon={<CircleDashed size={14} />}
        />
      </div>

      {/* Scan CTA + summary */}
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <ScanPanel
          loading={startScan.isPending}
          onScan={() => startScan.mutate()}
          error={scanError}
          primaryRelPath={primary?.relPath ?? null}
        />
        <LastScanSummary
          loading={lastScan.isLoading}
          report={report}
        />
      </div>

      <Collections list={collections.data ?? []} />

      <RunHistory runs={scans.data ?? []} />
    </div>
  );
}

function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-1 text-sm text-(--color-text-muted)">{description}</p>
      )}
    </div>
  );
}

function DryRunBanner({ dryRun }: { dryRun: boolean }) {
  if (!dryRun) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-900 dark:text-emerald-200">
        <ShieldCheck size={16} />
        <span>
          <strong className="font-semibold">Live mode.</strong> Quarantine actions
          will move bytes on disk.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-lg border-l-2 border-amber-500 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-semibold">Dry-run is enabled.</p>
        <p className="mt-0.5 text-xs leading-relaxed">
          Scans produce a planned-actions report; nothing is moved. Disable
          from <span className="font-medium">Settings</span> after reviewing the
          report.
        </p>
      </div>
    </div>
  );
}

function ScanPanel({
  loading,
  onScan,
  error,
  primaryRelPath,
}: {
  loading: boolean;
  onScan: () => void;
  error: string | null;
  primaryRelPath: string | null;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader title="Run a scan" description="Walks every collection and classifies." />
      <CardBody className="flex flex-1 flex-col justify-between gap-4">
        <div className="space-y-3 text-sm text-(--color-text-muted)">
          <Row label="Primary collection">
            {primaryRelPath ? (
              <span className="inline-flex items-center gap-1.5 font-mono text-xs text-(--color-text)">
                <Star size={12} className="text-amber-500" />
                {primaryRelPath}
              </span>
            ) : (
              <span className="text-(--color-danger)">none — set one first</span>
            )}
          </Row>
          <Row label="Mode">
            <span className="font-mono text-xs">dry-run report only</span>
          </Row>
        </div>
        <div className="space-y-2">
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            leadingIcon={<Play size={16} fill="currentColor" />}
            loading={loading}
            disabled={!primaryRelPath}
            onClick={onScan}
          >
            {loading ? 'Scanning…' : 'Scan now'}
          </Button>
          {error && (
            <p className="rounded bg-(--color-danger)/10 px-2.5 py-1.5 text-xs text-(--color-danger)">
              {error}
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-(--color-text-subtle)">
        {label}
      </span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

function LastScanSummary({
  loading,
  report,
}: {
  loading: boolean;
  report: DryRunReport | null;
}) {
  if (loading) {
    return (
      <Card>
        <CardHeader title="Last scan" />
        <CardBody>
          <div className="space-y-2">
            <Skeleton w="60%" />
            <Skeleton w="40%" />
            <Skeleton w="80%" />
          </div>
        </CardBody>
      </Card>
    );
  }
  if (!report) {
    return (
      <Card>
        <CardHeader title="Last scan" description="Nothing yet — run one." />
        <CardBody>
          <p className="text-sm text-(--color-text-muted)">
            Once a scan completes, the planned actions and sanity-guard verdict
            land here.
          </p>
        </CardBody>
      </Card>
    );
  }
  const sg = report.sanityGuard;
  const reasons = Object.entries(report.countsByReason).sort(
    ([, a], [, b]) => b.bytes - a.bytes,
  );
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            Last scan
            <span className="text-(--color-text-subtle) tabular-nums">
              #{report.runId}
            </span>
          </span>
        }
        description={`${report.presetName} · ${formatRelativeTime(report.generatedAt)}`}
        action={
          <Badge tone={sg.passed ? 'success' : 'danger'}>
            {sg.passed ? (
              <>
                <CheckCircle2 size={11} /> sanity ok
              </>
            ) : (
              <>
                <AlertTriangle size={11} /> sanity tripped
              </>
            )}
          </Badge>
        }
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-3 gap-2 rounded-md border border-(--color-border) bg-(--color-surface) p-3 text-center text-sm">
          <Inline label="Actions" value={formatCount(report.totalActions)} />
          <Inline label="Bytes" value={formatBytes(report.totalBytes)} />
          <Inline label="Review" value={formatCount(report.reviewPairs)} />
        </div>

        {!sg.passed && sg.reason && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-900 dark:text-rose-200">
            <p className="font-semibold">Sanity guard tripped:</p>
            <p className="mt-0.5 leading-relaxed">{sg.reason}</p>
            <p className="mt-1.5 tabular-nums">
              files {formatPercent(sg.filesPct)} · bytes {formatPercent(sg.bytesPct)}
            </p>
          </div>
        )}

        {reasons.length > 0 ? (
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-(--color-text-muted)">
              By reason
            </h4>
            <ul className="divide-y divide-(--color-border) overflow-hidden rounded-md border border-(--color-border)">
              {reasons.map(([reason, c]) => {
                const pctOfTotal = report.totalBytes > 0 ? c.bytes / report.totalBytes : 0;
                return (
                  <li
                    key={reason}
                    className="flex items-center gap-3 bg-(--color-surface) px-3 py-2"
                  >
                    <ReasonDot reason={reason} />
                    <span className="flex-1 truncate font-mono text-xs">
                      {reason}
                    </span>
                    <span className="text-xs text-(--color-text-muted) tabular-nums">
                      {formatCount(c.files)} · {formatBytes(c.bytes)}
                    </span>
                    <span className="ml-2 inline-block w-12 text-right text-[10.5px] text-(--color-text-subtle) tabular-nums">
                      {formatPercent(pctOfTotal)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-(--color-text-muted)">
            No actions planned — collections are clean.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Inline({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-(--color-text-subtle)">
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ReasonDot({ reason }: { reason: string }) {
  const tone =
    reason.startsWith('cruft_')
      ? 'text-amber-500'
      : reason.startsWith('duplicate_')
        ? 'text-(--color-accent-500)'
        : 'text-(--color-text-subtle)';
  return <CircleDot size={10} className={tone} />;
}

function Collections({ list }: { list: ReadonlyArray<{ id: number; relPath: string; isPrimary: boolean }> }) {
  if (list.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Collections"
        description="Auto-discovered top-level folders inside target_root."
      />
      <CardBody className="p-0">
        <ul className="divide-y divide-(--color-border)">
          {list.map((c) => (
            <li
              key={c.id}
              className={cn(
                'flex items-center gap-3 px-4 py-2.5 text-sm',
                c.isPrimary && 'bg-(--color-accent-100)/30 dark:bg-(--color-accent-100)/10',
              )}
            >
              <Boxes
                size={15}
                className={cn(
                  c.isPrimary
                    ? 'text-(--color-accent-600) dark:text-(--color-accent-300)'
                    : 'text-(--color-text-subtle)',
                )}
              />
              <span className="flex-1 truncate font-mono text-sm">
                {c.relPath}
              </span>
              {c.isPrimary && <Badge tone="accent">primary</Badge>}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function RunHistory({ runs }: { runs: ReadonlyArray<RunRow> }) {
  const last = runs.slice(0, 6);
  return (
    <Card>
      <CardHeader title="Recent runs" />
      <CardBody className="p-0">
        {last.length === 0 ? (
          <p className="px-4 py-3 text-sm text-(--color-text-muted)">
            No runs yet.
          </p>
        ) : (
          <ul className="divide-y divide-(--color-border)">
            {last.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 px-4 py-2 text-xs tabular-nums"
              >
                <span className="w-12 text-(--color-text-subtle)">#{r.id}</span>
                <span className="w-24 font-mono text-(--color-text-muted)">{r.kind}</span>
                <RunStatusBadge status={r.status} />
                <span className="flex-1 text-right text-(--color-text-subtle)">
                  {formatRelativeTime(r.started_at)}
                </span>
                <ChevronRight size={13} className="text-(--color-text-subtle)" />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function RunStatusBadge({ status }: { status: RunRow['status'] }) {
  const tone =
    status === 'completed'
      ? 'success'
      : status === 'running'
        ? 'accent'
        : status === 'crashed' || status === 'failed' || status === 'aborted'
          ? 'danger'
          : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

function Skeleton({ w }: { w?: string }) {
  return (
    <span
      className="inline-block h-4 animate-pulse rounded bg-(--color-surface-3)"
      style={{ width: w ?? '4rem' }}
    />
  );
}
