import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Lock, ShieldOff, Star } from 'lucide-react';
import { ApiError, type Config } from '../lib/apiClient.js';
import { useApi } from '../lib/apiContext.js';
import { keys } from '../lib/queryKeys.js';
import { Card, CardBody, CardHeader } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { Field, inputClass, selectClass } from '../components/Field.js';
import { Badge } from '../components/Badge.js';
import { cn } from '../lib/cn.js';
import { formatPercent } from '../lib/format.js';

const CONFIRMATION_PHRASE = 'I have reviewed the dry-run report';

/**
 * Settings — preset, retention, sanity-guard thresholds, dry-run gate, and
 * the primary collection. Each section is a Card so we can land/edit one
 * concern at a time without modal flow.
 *
 * The full type-to-confirm dialog (M12) is not yet wired; the inline form
 * below already gates on the exact phrase, so the user can disable dry-run
 * today without the modal — M12 just upgrades the affordance.
 */
export function SettingsPage() {
  return (
    <div className="space-y-6">
      <Header />
      <PrimaryCollectionCard />
      <PresetCard />
      <RetentionAndGuardsCard />
      <DryRunCard />
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-(--color-text-muted)">
        Preset, retention, sanity-guard thresholds, and the dry-run gate.
        Changes persist to <span className="font-mono">.dedupe/state.db</span>.
      </p>
    </div>
  );
}

// ---------- Primary collection ----------

function PrimaryCollectionCard() {
  const api = useApi();
  const qc = useQueryClient();
  const collections = useQuery({
    queryKey: keys.collections(),
    queryFn: () => api.listCollections(),
  });
  const setPrimary = useMutation({
    mutationFn: (id: number) => api.setPrimary(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.collections() }),
  });

  const list = collections.data ?? [];
  return (
    <Card>
      <CardHeader
        title="Primary collection"
        description="The collection that wins ties when duplicates span collections. Other collections are ranked by path priority."
      />
      <CardBody className="p-0">
        {list.length === 0 ? (
          <p className="p-4 text-sm text-(--color-text-muted)">
            No collections discovered yet — create top-level folders inside
            target_root.
          </p>
        ) : (
          <ul className="divide-y divide-(--color-border)">
            {list.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 px-4 py-2.5 text-sm"
              >
                <Star
                  size={14}
                  className={cn(
                    c.isPrimary
                      ? 'fill-amber-400 text-amber-500'
                      : 'text-(--color-text-subtle)',
                  )}
                />
                <span className="flex-1 truncate font-mono">{c.relPath}</span>
                {c.isPrimary ? (
                  <Badge tone="accent">primary</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPrimary.mutate(c.id)}
                    disabled={setPrimary.isPending}
                  >
                    Make primary
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ---------- Preset ----------

function PresetCard() {
  const api = useApi();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: keys.config(), queryFn: () => api.getConfig() });
  const presets = useQuery({ queryKey: keys.presets(), queryFn: () => api.listPresets() });
  const update = useMutation({
    mutationFn: (active_preset: string) => api.putConfig({ active_preset }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.config() }),
  });

  const active = config.data?.active_preset ?? '';
  const selected = useMemo(
    () => presets.data?.find((p) => p.name === active) ?? null,
    [presets.data, active],
  );

  return (
    <Card>
      <CardHeader title="Classification preset" description="Determines what counts as cruft and how duplicates are ranked." />
      <CardBody className="space-y-4">
        <Field label="Active preset" htmlFor="preset-select">
          <select
            id="preset-select"
            className={selectClass}
            value={active}
            onChange={(e) => update.mutate(e.target.value)}
            disabled={update.isPending || presets.isLoading}
          >
            {(presets.data ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {selected && (
          <div className="rounded-md border border-(--color-border) bg-(--color-surface) p-3 text-xs text-(--color-text-muted)">
            <p className="text-(--color-text)">{selected.description || '—'}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 tabular-nums">
              <Stat n={selected.cruft_rules.length} label="cruft rules" />
              <Stat n={selected.whitelist.length} label="whitelist" />
              <Stat n={selected.path_priority.length} label="priority" />
            </dl>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div className="text-base font-semibold text-(--color-text)">{n}</div>
      <div className="text-[10.5px] uppercase tracking-wider text-(--color-text-subtle)">
        {label}
      </div>
    </div>
  );
}

// ---------- Retention + guards ----------

function RetentionAndGuardsCard() {
  const api = useApi();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: keys.config(), queryFn: () => api.getConfig() });
  const update = useMutation({
    mutationFn: (patch: Partial<Omit<Config, 'dry_run' | 'dry_run_disabled_at'>>) =>
      api.putConfig(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.config() }),
  });

  const [days, setDays] = useState<string>('');
  const [filesPct, setFilesPct] = useState<number>(0.5);
  const [bytesPct, setBytesPct] = useState<number>(0.7);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from server.
  useEffect(() => {
    if (config.data) {
      setDays(String(config.data.retention_days));
      setFilesPct(config.data.sanity_guard_files_pct);
      setBytesPct(config.data.sanity_guard_bytes_pct);
    }
  }, [config.data]);

  const onSave = async () => {
    setError(null);
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      setError('retention_days must be an integer between 1 and 365');
      return;
    }
    try {
      await update.mutateAsync({
        retention_days: n,
        sanity_guard_files_pct: filesPct,
        sanity_guard_bytes_pct: bytesPct,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    }
  };

  const dirty =
    config.data != null &&
    (Number(days) !== config.data.retention_days ||
      filesPct !== config.data.sanity_guard_files_pct ||
      bytesPct !== config.data.sanity_guard_bytes_pct);

  return (
    <Card>
      <CardHeader
        title="Retention & sanity guards"
        description="How long quarantined files stick around, and how much of the primary the mover may touch in one run."
      />
      <CardBody className="space-y-5">
        <Field
          label="Retention (days)"
          hint="Quarantined files become eligible for purge after this many days. 1–365."
          htmlFor="retention-days"
        >
          <input
            id="retention-days"
            type="number"
            min={1}
            max={365}
            inputMode="numeric"
            className={cn(inputClass, 'w-32')}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </Field>

        <Slider
          label="Sanity guard — files"
          hint="Refuse the run if planned actions exceed this fraction of the primary's file count."
          value={filesPct}
          onChange={setFilesPct}
        />
        <Slider
          label="Sanity guard — bytes"
          hint="Refuse the run if planned actions exceed this fraction of the primary's bytes."
          value={bytesPct}
          onChange={setBytesPct}
        />

        <div className="flex items-center justify-between gap-3 border-t border-(--color-border) pt-3">
          {error ? (
            <p className="text-xs text-(--color-danger)">{error}</p>
          ) : (
            <p className="text-xs text-(--color-text-subtle)">
              {dirty ? 'Unsaved changes' : 'Up to date'}
            </p>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || update.isPending}
            loading={update.isPending}
            onClick={onSave}
          >
            Save
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function Slider({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-medium text-(--color-text-muted)">{label}</label>
        <span className="text-sm font-semibold tabular-nums">{formatPercent(value)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          'w-full accent-(--color-accent-500)',
          'h-1.5 cursor-ew-resize appearance-none rounded-full bg-(--color-surface-3)',
        )}
      />
      <p className="text-[11px] leading-relaxed text-(--color-text-subtle)">{hint}</p>
    </div>
  );
}

// ---------- Dry-run gate ----------

function DryRunCard() {
  const api = useApi();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: keys.config(), queryFn: () => api.getConfig() });
  const dryRun = config.data?.dry_run ?? true;
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const disable = useMutation({
    mutationFn: (p: string) => api.disableDryRun(p),
    onSuccess: () => {
      setPhrase('');
      setError(null);
      qc.invalidateQueries({ queryKey: keys.config() });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Failed');
    },
  });

  if (!dryRun) {
    return (
      <Card>
        <CardHeader
          title="Dry-run"
          description="Live mode is enabled. Quarantine actions move bytes."
          action={<Badge tone="success">live</Badge>}
        />
        <CardBody>
          <p className="text-sm text-(--color-text-muted)">
            Disabled at{' '}
            <span className="font-mono text-(--color-text)">
              {config.data?.dry_run_disabled_at ?? '—'}
            </span>
            . To re-enable, restart with a fresh DB or revert by issuing a
            DELETE against <span className="font-mono">.dedupe/state.db</span>.
          </p>
        </CardBody>
      </Card>
    );
  }

  const matches = phrase === CONFIRMATION_PHRASE;

  return (
    <Card>
      <CardHeader
        title="Disable dry-run"
        description="One-way switch. Once disabled, scans can produce executable plans."
        action={<Badge tone="warning">dry-run</Badge>}
      />
      <CardBody className="space-y-3">
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <ShieldOff size={14} className="mt-0.5 shrink-0" />
          <p>
            Type the confirmation phrase exactly. There is no undo from the
            UI; the mover is gated on this flag and will refuse otherwise.
          </p>
        </div>

        <Field
          label="Confirmation phrase"
          hint={
            <span className="font-mono text-[11px] text-(--color-text-subtle)">
              {CONFIRMATION_PHRASE}
            </span>
          }
          htmlFor="dryrun-phrase"
        >
          <div className="relative">
            <input
              id="dryrun-phrase"
              type="text"
              autoComplete="off"
              spellCheck={false}
              className={cn(inputClass, 'pr-9 font-mono')}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={CONFIRMATION_PHRASE}
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
              {matches ? (
                <CheckCircle2 size={16} className="text-emerald-500" />
              ) : (
                <Lock size={14} className="text-(--color-text-subtle)" />
              )}
            </span>
          </div>
        </Field>

        {error && (
          <p className="rounded bg-(--color-danger)/10 px-2.5 py-1.5 text-xs text-(--color-danger)">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button
            variant="danger"
            size="md"
            disabled={!matches || disable.isPending}
            loading={disable.isPending}
            onClick={() => disable.mutate(phrase)}
          >
            Disable dry-run
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
