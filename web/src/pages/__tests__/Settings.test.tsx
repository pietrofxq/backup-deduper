import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../Settings.js';
import { buildMockApi, renderWithProviders } from '../../test-utils.js';
import type { Collection, Config, Preset } from '../../lib/apiClient.js';

const baseConfig: Config = {
  active_preset: 'Samsung Android phone backup',
  retention_days: 30,
  dry_run: true,
  dry_run_disabled_at: null,
  sanity_guard_files_pct: 0.5,
  sanity_guard_bytes_pct: 0.7,
};

const presets: Preset[] = [
  {
    name: 'Samsung Android phone backup',
    description: 'Samsung Smart Switch defaults',
    cruft_rules: [],
    whitelist: [],
    path_priority: [],
  },
  {
    name: 'None (conservative defaults only)',
    description: 'Empty preset',
    cruft_rules: [],
    whitelist: [],
    path_priority: [],
  },
];

const collections: Collection[] = [
  { id: 1, relPath: 'Backup-A', isPrimary: true },
  { id: 2, relPath: 'Backup-B', isPrimary: false },
];

describe('SettingsPage', () => {
  it('renders all four cards', async () => {
    const api = buildMockApi({
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listPresets: vi.fn().mockResolvedValue(presets),
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<SettingsPage />, { api });

    expect(
      await screen.findByRole('heading', { name: /primary collection/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: /classification preset/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: /retention & sanity guards/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: /disable dry-run/i }),
    ).toBeInTheDocument();
  });

  it('switching the preset calls putConfig with active_preset', async () => {
    const putConfig = vi.fn().mockResolvedValue(baseConfig);
    const api = buildMockApi({
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listPresets: vi.fn().mockResolvedValue(presets),
      listCollections: vi.fn().mockResolvedValue(collections),
      putConfig,
    });

    renderWithProviders(<SettingsPage />, { api });

    const select = (await screen.findByLabelText(
      /active preset/i,
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(select.value).toBe('Samsung Android phone backup'),
    );
    await userEvent.selectOptions(select, 'None (conservative defaults only)');

    await waitFor(() =>
      expect(putConfig).toHaveBeenCalledWith({
        active_preset: 'None (conservative defaults only)',
      }),
    );
  });

  it('saving retention/sanity-guard values calls putConfig with the patch', async () => {
    const putConfig = vi.fn().mockResolvedValue(baseConfig);
    const api = buildMockApi({
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listPresets: vi.fn().mockResolvedValue(presets),
      listCollections: vi.fn().mockResolvedValue(collections),
      putConfig,
    });

    renderWithProviders(<SettingsPage />, { api });

    const days = (await screen.findByLabelText(/retention \(days\)/i)) as HTMLInputElement;
    await waitFor(() => expect(days.value).toBe('30'));
    await userEvent.clear(days);
    await userEvent.type(days, '14');

    const save = await screen.findByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);

    await waitFor(() =>
      expect(putConfig).toHaveBeenCalledWith({
        retention_days: 14,
        sanity_guard_files_pct: 0.5,
        sanity_guard_bytes_pct: 0.7,
      }),
    );
  });

  it('rejects retention value outside 1..365 with an inline error', async () => {
    const putConfig = vi.fn().mockResolvedValue(baseConfig);
    const api = buildMockApi({
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listPresets: vi.fn().mockResolvedValue(presets),
      listCollections: vi.fn().mockResolvedValue(collections),
      putConfig,
    });

    renderWithProviders(<SettingsPage />, { api });

    const days = (await screen.findByLabelText(/retention \(days\)/i)) as HTMLInputElement;
    await waitFor(() => expect(days.value).toBe('30'));
    await userEvent.clear(days);
    await userEvent.type(days, '0');

    const save = await screen.findByRole('button', { name: /^save$/i });
    await userEvent.click(save);

    expect(
      await screen.findByText(/retention_days must be an integer between 1 and 365/i),
    ).toBeInTheDocument();
    expect(putConfig).not.toHaveBeenCalled();
  });

  it('disable-dry-run button only enables when the exact phrase is typed', async () => {
    const disableDryRun = vi.fn().mockResolvedValue({
      ok: true,
      config: {
        ...baseConfig,
        dry_run: false,
        dry_run_disabled_at: '2025-01-01T00:00:00Z',
      },
    });
    const api = buildMockApi({
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listPresets: vi.fn().mockResolvedValue(presets),
      listCollections: vi.fn().mockResolvedValue(collections),
      disableDryRun,
    });

    renderWithProviders(<SettingsPage />, { api });

    const phrase = (await screen.findByLabelText(/confirmation phrase/i)) as HTMLInputElement;
    const button = await screen.findByRole('button', { name: /disable dry-run/i });

    expect(button).toBeDisabled();

    await userEvent.type(phrase, 'wrong words');
    expect(button).toBeDisabled();

    await userEvent.clear(phrase);
    await userEvent.type(phrase, 'I have reviewed the dry-run report');
    await waitFor(() => expect(button).not.toBeDisabled());
    await userEvent.click(button);

    await waitFor(() =>
      expect(disableDryRun).toHaveBeenCalledWith(
        'I have reviewed the dry-run report',
      ),
    );
  });

  it('Make-primary calls setPrimary with the collection id', async () => {
    const setPrimary = vi.fn().mockResolvedValue({ ok: true });
    const api = buildMockApi({
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listPresets: vi.fn().mockResolvedValue(presets),
      listCollections: vi.fn().mockResolvedValue(collections),
      setPrimary,
    });

    renderWithProviders(<SettingsPage />, { api });

    const button = await screen.findByRole('button', { name: /make primary/i });
    await userEvent.click(button);

    await waitFor(() => expect(setPrimary).toHaveBeenCalledWith(2));
  });
});
