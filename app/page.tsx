'use client';

import Papa from 'papaparse';
import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

type Granularity = 'daily' | 'weekly' | 'monthly';

type CsvRow = Record<string, string>;

type DataRow = {
  day: Date;
  os: 'android' | 'ios' | 'other';
  country: string;
  network: string;
  campaign: string;
  installs: number;
  payingUsers: number;
  cost: number;
  revenueByCohort: Record<string, number>;
  retentionByCohort: Record<string, number>;
};

type HeatmapOrderBy = 'cohort_date' | 'os' | 'country' | 'network' | 'campaign';
type QuickDatePreset =
  | 'all_time'
  | 'last_5_months'
  | 'last_3_months'
  | 'last_2_months'
  | 'last_month'
  | 'this_month'
  | 'last_30_days'
  | 'last_14_days'
  | 'last_7_days'
  | 'yesterday'
  | 'custom';

const OS_MAP: Record<string, DataRow['os']> = {
  google_play: 'android',
  app_store: 'ios'
};

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value: string | undefined): number {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function periodKey(day: Date, granularity: Granularity): string {
  if (granularity === 'daily') {
    return day.toISOString().slice(0, 10);
  }

  if (granularity === 'monthly') {
    return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  const date = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 1);
  return date.toISOString().slice(0, 10);
}

function periodEndDate(period: string, granularity: Granularity): Date {
  if (granularity === 'daily') {
    return new Date(`${period}T00:00:00.000Z`);
  }
  if (granularity === 'weekly') {
    const start = new Date(`${period}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() + 6);
    return start;
  }
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0));
}

function heatmapStyle(
  value: number | null,
  maxRoas: number,
  isDarkMode: boolean
): { backgroundColor: string; color: string } {
  if (value === null) {
    return {
      backgroundColor: isDarkMode ? '#1f2f4d' : '#dbeafe',
      color: '#f8fafc'
    };
  }
  const ratio = maxRoas > 0 ? Math.min(Math.max(value / maxRoas, 0), 1) : 0;
  const low = { r: 30, g: 64, b: 107 };
  const mid = { r: 36, g: 128, b: 140 };
  const high = { r: 38, g: 148, b: 63 };
  const blend = (from: number, to: number, amount: number) => from + (to - from) * amount;
  const segment = ratio <= 0.55 ? ratio / 0.55 : (ratio - 0.55) / 0.45;
  const from = ratio <= 0.55 ? low : mid;
  const to = ratio <= 0.55 ? mid : high;
  const r = Math.round(blend(from.r, to.r, segment));
  const g = Math.round(blend(from.g, to.g, segment));
  const b = Math.round(blend(from.b, to.b, segment));
  return {
    backgroundColor: `rgb(${r}, ${g}, ${b})`,
    color: '#f8fafc'
  };
}

function optionValues(rows: DataRow[], field: keyof Pick<DataRow, 'os' | 'country' | 'network' | 'campaign'>): string[] {
  return Array.from(new Set(rows.map((row) => String(row[field])))).sort((a, b) => a.localeCompare(b));
}

function formatCohort(cohortKey: string): string {
  return `ROAS ${normalizeCohortLabel(cohortKey)}`;
}

function normalizeCohortLabel(cohortKey: string): string {
  const raw = cohortKey
    .replace('all_revenue_total_', '')
    .replace('retention_rate_', '')
    .toUpperCase();
  if (raw === 'M6') return 'D180';
  if (raw === 'M12') return 'D360';
  return raw;
}

function cohortSortValue(cohortKey: string): number {
  const raw = cohortKey
    .replace('all_revenue_total_', '')
    .replace('retention_rate_', '')
    .toLowerCase();
  if (raw.startsWith('d')) {
    const day = Number(raw.slice(1));
    return Number.isFinite(day) ? day : Number.MAX_SAFE_INTEGER - 1;
  }
  if (raw.startsWith('m')) {
    const month = Number(raw.slice(1));
    return Number.isFinite(month) ? month * 30 : Number.MAX_SAFE_INTEGER;
  }
  return Number.MAX_SAFE_INTEGER;
}

function cohortWindowDays(cohortKey: string): number {
  const raw = cohortKey
    .replace('all_revenue_total_', '')
    .replace('retention_rate_', '')
    .toLowerCase();
  if (raw.startsWith('d')) {
    const day = Number(raw.slice(1));
    return Number.isFinite(day) ? day : 0;
  }
  if (raw.startsWith('m')) {
    const month = Number(raw.slice(1));
    return Number.isFinite(month) ? month * 30 : 0;
  }
  return 0;
}

function ratioKey(from: string, to: string): string {
  return `${from}=>${to}`;
}

type RatioStage = 'early' | 'mid' | 'late';
type RatioSamplingStrategy = 'all_time' | 'calendar_window' | 'last_mature_cohorts';
const RATIO_SAMPLING_CONFIG = {
  midWindowDays: 180,
  lateMatureCohortLimit: {
    d120: 12,
    d180: 12,
    d360: 8
  }
};

function getRatioStage(toCohort: string): RatioStage {
  const toDays = cohortWindowDays(toCohort);
  if (toDays <= 30) return 'early';
  if (toDays <= 90) return 'mid';
  return 'late';
}

function getRatioSamplingStrategy(toCohort: string): RatioSamplingStrategy {
  const stage = getRatioStage(toCohort);
  if (stage === 'early') return 'all_time';
  if (stage === 'mid') return 'calendar_window';
  return 'last_mature_cohorts';
}

function getLateStageMatureCohortLimit(toCohort: string): number {
  const toDays = cohortWindowDays(toCohort);
  if (toDays >= 360) return RATIO_SAMPLING_CONFIG.lateMatureCohortLimit.d360;
  if (toDays >= 180) return RATIO_SAMPLING_CONFIG.lateMatureCohortLimit.d180;
  if (toDays >= 120) return RATIO_SAMPLING_CONFIG.lateMatureCohortLimit.d120;
  return 12;
}

function filterRowsForRatioSampling(args: {
  rows: DataRow[];
  toCohort: string;
  maxDay: Date;
}): {
  rows: DataRow[];
  debug: { strategy: RatioSamplingStrategy; candidates: number; maturedCandidates: number; selected: number; minDate: string | null; maxDate: string | null };
} {
  const { rows, toCohort, maxDay } = args;
  const toDays = cohortWindowDays(toCohort);
  const maturedRows = rows.filter((row) => row.day.getTime() + toDays * 86400000 <= maxDay.getTime());
  const strategy = getRatioSamplingStrategy(toCohort);
  let selected: DataRow[] = maturedRows;

  if (strategy === 'calendar_window') {
    selected = maturedRows.filter(
      (row) => row.day.getTime() >= maxDay.getTime() - RATIO_SAMPLING_CONFIG.midWindowDays * 86400000
    );
  }
  if (strategy === 'last_mature_cohorts') {
    const limit = getLateStageMatureCohortLimit(toCohort);
    const uniqueDays = Array.from(new Set(maturedRows.map((row) => row.day.toISOString().slice(0, 10))))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit);
    const daySet = new Set(uniqueDays);
    selected = maturedRows.filter((row) => daySet.has(row.day.toISOString().slice(0, 10)));
  }

  const sortedDates = selected
    .map((row) => row.day.toISOString().slice(0, 10))
    .sort((a, b) => a.localeCompare(b));
  return {
    rows: selected,
    debug: {
      strategy,
      candidates: rows.length,
      maturedCandidates: maturedRows.length,
      selected: selected.length,
      minDate: sortedDates[0] ?? null,
      maxDate: sortedDates[sortedDates.length - 1] ?? null
    }
  };
}

function getMinSamplesForRatio(toCohort: string): number {
  return getRatioStage(toCohort) === 'late' ? 3 : 6;
}

function clampHistoricalRatio(value: number, minRatio: number, maxRatio: number): number {
  return Math.min(Math.max(value, minRatio), maxRatio);
}

function buildTrimmedWeightedMean(
  samples: Array<{ ratio: number; weight: number }>,
  trimPercent: number,
  minKeepCount: number
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.ratio - b.ratio);
  const trimCount = Math.floor(sorted.length * trimPercent);
  const safeTrim = Math.max(0, Math.min(trimCount, Math.floor((sorted.length - minKeepCount) / 2)));
  const trimmed = sorted.slice(safeTrim, sorted.length - safeTrim);
  if (trimmed.length === 0) return null;
  const totalWeight = trimmed.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return null;
  return trimmed.reduce((sum, item) => sum + item.ratio * item.weight, 0) / totalWeight;
}

function resolveBlendedFallbackRatio(levels: {
  campaign: { value: number | null; count: number };
  network: { value: number | null; count: number };
  country: { value: number | null; count: number };
  global: { value: number | null; count: number };
  minSamples: number;
}): { ratio: number | null; blendApplied: boolean } {
  const { campaign, network, country, global, minSamples } = levels;
  const hasCampaign = campaign.value !== null && campaign.count > 0;
  const hasNetwork = network.value !== null && network.count > 0;
  const hasCountry = country.value !== null && country.count > 0;
  const hasGlobal = global.value !== null && global.count > 0;

  const parts: Array<{ value: number; weight: number }> = [];
  const push = (value: number | null, weight: number) => {
    if (value !== null && weight > 0) parts.push({ value, weight });
  };

  if (hasCampaign && campaign.count >= minSamples) {
    push(campaign.value, 0.7);
    push(network.value, 0.2);
    push(global.value, 0.1);
  } else if (hasCampaign) {
    push(campaign.value, 0.4);
    push(network.value, 0.4);
    push(global.value, 0.2);
  } else if (hasNetwork && network.count >= minSamples) {
    push(network.value, 0.7);
    push(country.value, 0.2);
    push(global.value, 0.1);
  } else if (hasNetwork) {
    push(network.value, 0.5);
    push(country.value, 0.3);
    push(global.value, 0.2);
  } else if (hasCountry) {
    push(country.value, 0.75);
    push(global.value, 0.25);
  } else if (hasGlobal) {
    push(global.value, 1);
  }

  if (parts.length === 0) return { ratio: null, blendApplied: false };
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  const ratio = parts.reduce((sum, part) => sum + part.value * part.weight, 0) / total;
  return { ratio, blendApplied: parts.length > 1 };
}

function applyLateStageFlatlineGuard(args: {
  ratio: number | null;
  toCohort: string;
  flatlineThreshold: number;
  recentEvidenceAvg: number | null;
  recentEvidenceCount: number;
  minSamples: number;
  evidenceMinAvg: number;
}): { ratio: number | null; applied: boolean } {
  const { ratio, toCohort, flatlineThreshold, recentEvidenceAvg, recentEvidenceCount, minSamples, evidenceMinAvg } = args;
  if (ratio === null || getRatioStage(toCohort) !== 'late') return { ratio, applied: false };
  if (ratio >= flatlineThreshold) return { ratio, applied: false };
  if (recentEvidenceAvg === null || recentEvidenceCount < minSamples || recentEvidenceAvg <= evidenceMinAvg) {
    return { ratio, applied: false };
  }
  return { ratio: recentEvidenceAvg, applied: true };
}

function deriveCountry(row: CsvRow): string {
  const explicit =
    row.country || row.country_code || row.countryCode || row.geo || row.region || row.market;
  if (explicit && explicit.trim()) {
    return explicit.trim().toUpperCase();
  }
  const campaign = row.campaign_network || '';
  const match = campaign.match(/(?:^|[^A-Z])([A-Z]{2})(?:[^A-Z]|$)/);
  return match?.[1] ?? 'UNKNOWN';
}

function buildLinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function buildChartTone(index: number, total: number): { color: string; accent: string } {
  const safeTotal = Math.max(total, 1);
  const hue = (195 + (index * 320) / safeTotal) % 360;
  return {
    color: `hsl(${hue} 85% 61%)`,
    accent: `hsl(${(hue + 24) % 360} 82% 57%)`
  };
}

function matchesSelection(value: string, selectedValues: string[]): boolean {
  return selectedValues.length === 0 || selectedValues.includes(value);
}

function toggleValue(current: string[], value: string): string[] {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function selectionText(selected: string[]): string {
  if (selected.length === 0) {
    return 'Todos';
  }
  if (selected.length === 1) {
    return selected[0];
  }
  return `${selected.length} seleccionados`;
}

function MultiSelect({
  title,
  options,
  selected,
  onChange,
  searchable = false
}: {
  title: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const visibleOptions = useMemo(() => {
    const normalized = searchTerm.trim().toLowerCase();
    if (!normalized) {
      return options;
    }
    return options.filter((option) => option.toLowerCase().includes(normalized));
  }, [options, searchTerm]);

  return (
    <details className="multiSelect" open>
      <summary>
        <span>{title}</span>
        <span className="selectedValue">{selectionText(selected)}</span>
      </summary>
      <div className="multiSelectList">
        {searchable && (
          <input
            className="searchInput"
            type="text"
            placeholder={`Buscar ${title.toLowerCase()}...`}
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        )}
        <button type="button" className="clearBtn" onClick={() => onChange([])}>
          Seleccionar todo
        </button>
        {visibleOptions.map((option) => {
          const checked = selected.includes(option);
          return (
            <label key={option} className="optionRow">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onChange(toggleValue(selected, option))}
              />
              <span>{option}</span>
            </label>
          );
        })}
      </div>
    </details>
  );
}

export default function Page() {
  const [rows, setRows] = useState<DataRow[]>([]);
  const [availableCohorts, setAvailableCohorts] = useState<string[]>([]);
  const [availableRetentionCohorts, setAvailableRetentionCohorts] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<Granularity>('weekly');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedOs, setSelectedOs] = useState<string[]>([]);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedNetworks, setSelectedNetworks] = useState<string[]>([]);
  const [selectedCampaigns, setSelectedCampaigns] = useState<string[]>([]);
  const [maturedOnly, setMaturedOnly] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [enablePrediction, setEnablePrediction] = useState(false);
  const [enableCountryFallback, setEnableCountryFallback] = useState(true);
  const [compareMode, setCompareMode] = useState<'previous_period' | 'none'>('previous_period');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataSourceLabel, setDataSourceLabel] = useState('Campaign data.csv');
  const [selectedRatioKeys, setSelectedRatioKeys] = useState<string[]>([]);
  const [hoveredRatioIndex, setHoveredRatioIndex] = useState<number | null>(null);
  const [bottomChartMode, setBottomChartMode] = useState<'roas' | 'ratios'>('roas');
  const [ratioTableHeatmapEnabled, setRatioTableHeatmapEnabled] = useState(true);
  const [ratioTableMode, setRatioTableMode] = useState<'growth' | 'distribution'>('growth');
  const [mainViewTab, setMainViewTab] = useState<'dashboard' | 'graficos'>('dashboard');
  const [heatmapOrderBy, setHeatmapOrderBy] = useState<HeatmapOrderBy>('cohort_date');
  const [quickDatePreset, setQuickDatePreset] = useState<QuickDatePreset>('last_3_months');
  const [secondaryTableMode, setSecondaryTableMode] = useState<'ltv' | 'ratios' | 'retained'>('ltv');

  useEffect(() => {
    document.body.dataset.theme = isDarkMode ? 'dark' : 'light';
  }, [isDarkMode]);

  const applyParsedCsv = (result: Papa.ParseResult<CsvRow>, label: string) => {
    const fields = result.meta.fields ?? [];
    const cohorts = fields
      .filter((field) => field.startsWith('all_revenue_total_'))
      .sort((a, b) => cohortSortValue(a) - cohortSortValue(b));
    const retentionCohorts = fields
      .filter((field) => field.startsWith('retention_rate_'))
      .sort((a, b) => cohortSortValue(a) - cohortSortValue(b));

    const parsed = result.data
      .map((row) => {
        const dayRaw = row.day;
        const day = new Date(`${dayRaw}T00:00:00Z`);
        if (!dayRaw || Number.isNaN(day.getTime())) {
          return null;
        }

        const revenueByCohort: Record<string, number> = {};
        cohorts.forEach((cohort) => {
          revenueByCohort[cohort] = parseNumber(row[cohort]);
        });
        const retentionByCohort: Record<string, number> = {};
        retentionCohorts.forEach((cohort) => {
          const rawValue = parseOptionalNumber(row[cohort]);
          retentionByCohort[cohort] = rawValue > 1 ? rawValue / 100 : rawValue;
        });

        return {
          day,
          os: OS_MAP[row.store_type] ?? 'other',
          country: deriveCountry(row),
          network: row.channel?.trim() || 'unknown',
          campaign: row.campaign_network?.trim() || 'unknown',
          installs: parseOptionalNumber(row.installs),
          payingUsers: parseOptionalNumber(
            row.paying_users ??
              row.payingUsers ??
              row.payers ??
              row.unique_payers ??
              row['paying users']
          ),
          cost: parseNumber(row.cost),
          revenueByCohort,
          retentionByCohort
        } satisfies DataRow;
      })
      .filter((row): row is DataRow => row !== null)
      .sort((a, b) => a.day.getTime() - b.day.getTime());

    setRows(parsed);
    setAvailableCohorts(cohorts);
    setAvailableRetentionCohorts(retentionCohorts);
    setDataSourceLabel(label);
    setLoadError(null);

    if (parsed.length > 0) {
      setFromDate(parsed[0].day.toISOString().slice(0, 10));
      setToDate(parsed[parsed.length - 1].day.toISOString().slice(0, 10));
    }
  };

  useEffect(() => {
    Papa.parse<CsvRow>('/Campaign data.csv', {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        if ((result.data?.length ?? 0) === 0) {
          setLoadError('No se pudo cargar el CSV por URL. Puedes subirlo manualmente abajo.');
          return;
        }
        applyParsedCsv(result, 'Campaign data.csv (public)');
      },
      error: () => {
        setLoadError('No se pudo cargar el CSV por URL. Puedes subirlo manualmente abajo.');
      }
    });
  }, []);

  const handleCsvUpload = (file: File) => {
    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        if ((result.data?.length ?? 0) === 0) {
          setLoadError('El archivo subido no tiene filas válidas.');
          return;
        }
        applyParsedCsv(result, file.name);
      },
      error: () => {
        setLoadError('Error al parsear el archivo CSV subido.');
      }
    });
  };

  const filteredByDate = useMemo(() => {
    return rows.filter((row) => {
      const value = row.day.toISOString().slice(0, 10);
      if (fromDate && value < fromDate) {
        return false;
      }
      if (toDate && value > toDate) {
        return false;
      }
      return true;
    });
  }, [rows, fromDate, toDate]);

  const osOptions = useMemo(() => optionValues(filteredByDate, 'os'), [filteredByDate]);
  const countryOptions = useMemo(() => {
    const source = filteredByDate.filter((row) => matchesSelection(row.os, selectedOs));
    return optionValues(source, 'country');
  }, [filteredByDate, selectedOs]);

  const networkOptions = useMemo(() => {
    const source = filteredByDate.filter(
      (row) => matchesSelection(row.os, selectedOs) && matchesSelection(row.country, selectedCountries)
    );
    return optionValues(source, 'network');
  }, [filteredByDate, selectedOs, selectedCountries]);

  const campaignOptions = useMemo(() => {
    const source = filteredByDate.filter(
      (row) =>
        matchesSelection(row.os, selectedOs) &&
        matchesSelection(row.country, selectedCountries) &&
        matchesSelection(row.network, selectedNetworks)
    );
    return optionValues(source, 'campaign');
  }, [filteredByDate, selectedOs, selectedCountries, selectedNetworks]);

  useEffect(() => {
    setSelectedOs((current) => current.filter((value) => osOptions.includes(value)));
  }, [osOptions]);

  useEffect(() => {
    setSelectedCountries((current) => current.filter((value) => countryOptions.includes(value)));
  }, [countryOptions]);

  useEffect(() => {
    setSelectedNetworks((current) => current.filter((value) => networkOptions.includes(value)));
  }, [networkOptions]);

  useEffect(() => {
    setSelectedCampaigns((current) => current.filter((value) => campaignOptions.includes(value)));
  }, [campaignOptions]);

  const scopedRows = useMemo(() => {
    return filteredByDate.filter(
      (row) =>
        matchesSelection(row.os, selectedOs) &&
        matchesSelection(row.country, selectedCountries) &&
        matchesSelection(row.network, selectedNetworks) &&
        matchesSelection(row.campaign, selectedCampaigns)
    );
  }, [filteredByDate, selectedOs, selectedCountries, selectedNetworks, selectedCampaigns]);

  const heatmapRows = useMemo(() => {
    if (quickDatePreset === 'custom') {
      return scopedRows.filter((row) => {
        const value = row.day.toISOString().slice(0, 10);
        if (fromDate && value < fromDate) return false;
        if (toDate && value > toDate) return false;
        return true;
      });
    }
    if (quickDatePreset === 'all_time' || scopedRows.length === 0) {
      return scopedRows;
    }

    const maxDate = scopedRows.reduce((max, row) => (row.day > max ? row.day : max), new Date(0));
    const start = new Date(maxDate);
    const end = new Date(maxDate);
    const dayMs = 86400000;

    if (quickDatePreset === 'last_5_months') start.setUTCMonth(start.getUTCMonth() - 5);
    if (quickDatePreset === 'last_3_months') start.setUTCMonth(start.getUTCMonth() - 3);
    if (quickDatePreset === 'last_2_months') start.setUTCMonth(start.getUTCMonth() - 2);
    if (quickDatePreset === 'last_month') start.setUTCMonth(start.getUTCMonth() - 1);
    if (quickDatePreset === 'this_month') {
      start.setUTCDate(1);
    }
    if (quickDatePreset === 'last_30_days') start.setTime(end.getTime() - 29 * dayMs);
    if (quickDatePreset === 'last_14_days') start.setTime(end.getTime() - 13 * dayMs);
    if (quickDatePreset === 'last_7_days') start.setTime(end.getTime() - 6 * dayMs);
    if (quickDatePreset === 'yesterday') {
      start.setTime(end.getTime() - dayMs);
      end.setTime(start.getTime());
    }

    const startMs = start.getTime();
    const endMs = end.getTime();
    return scopedRows.filter((row) => row.day.getTime() >= startMs && row.day.getTime() <= endMs);
  }, [scopedRows, quickDatePreset, fromDate, toDate]);

  const organicRetentionRows = useMemo(() => {
    return filteredByDate.filter(
      (row) =>
        matchesSelection(row.os, selectedOs) &&
        matchesSelection(row.country, selectedCountries) &&
        /organic/i.test(`${row.network} ${row.campaign}`)
    );
  }, [filteredByDate, selectedOs, selectedCountries]);

  const networkHistoricalRetentionRows = useMemo(() => {
    const activeNetworks =
      selectedNetworks.length > 0
        ? selectedNetworks
        : Array.from(new Set(scopedRows.map((row) => row.network)));

    return filteredByDate.filter(
      (row) =>
        matchesSelection(row.os, selectedOs) &&
        matchesSelection(row.country, selectedCountries) &&
        (activeNetworks.length === 0 || activeNetworks.includes(row.network)) &&
        (selectedCampaigns.length === 0 || !selectedCampaigns.includes(row.campaign))
    );
  }, [filteredByDate, selectedOs, selectedCountries, selectedNetworks, selectedCampaigns, scopedRows]);

  const { orderedPeriods, periodCost, periodInstalls, periodCpi, periodRoas, periodLtv, predictedRoas, predictedMask, ratioSummary, periodJumpRatios, ratioDebugInfo, maxRoas, maturityDiagnostics } = useMemo(() => {
    const RATIO_PREDICTION_CONFIG = {
      trimPercent: 0.1,
      trimMinKeepCount: 4,
      clampMin: 0.85,
      clampMax: 1.8,
      lateFlatlineThreshold: 1.02,
      lateEvidenceMinAvg: 1.05
    };
    const groupKeyFromRow = (row: DataRow): string => {
      if (heatmapOrderBy === 'os') return row.os.toUpperCase();
      if (heatmapOrderBy === 'country') return row.country;
      if (heatmapOrderBy === 'network') return row.network;
      if (heatmapOrderBy === 'campaign') return row.campaign;
      return periodKey(row.day, granularity);
    };
    const periodAggregation = new Map<
      string,
      {
        totalCost: number;
        totalInstalls: number;
        totalPayingUsers: number;
        revenueByCohort: Record<string, number>;
        cohortCost: Record<string, number>;
        maturedCohortCost: Record<string, number>;
        osCost: Record<string, number>;
        osCountryCost: Record<string, Record<string, number>>;
        maxDay: Date;
      }
    >();
    const maxAvailableDay = heatmapRows.reduce((max, row) => (row.day > max ? row.day : max), new Date(0));
    const maxAvailableDayGlobal = rows.reduce((max, row) => (row.day > max ? row.day : max), new Date(0));
    const createAccumulator = (): Record<string, Record<string, Array<{ ratio: number; weight: number }>>> => ({
      android: {},
      ios: {},
      other: {}
    });
    const campaignRatioAccumulator = createAccumulator();
    const networkRatioAccumulator = createAccumulator();
    const countryRatioAccumulator: Record<
      string,
      Record<string, Record<string, Array<{ ratio: number; weight: number }>>>
    > = { android: {}, ios: {}, other: {} };
    const osRatioAccumulator = createAccumulator();

    const cohortPairs = availableCohorts
      .slice(0, -1)
      .map((cohort, index) => [cohort, availableCohorts[index + 1]] as const);

    const accumulateRatios = (
      sourceRows: DataRow[],
      accumulator: Record<string, Record<string, Array<{ ratio: number; weight: number }>>>,
      maxDay: Date,
      debugCollector: Record<string, { strategy: RatioSamplingStrategy; candidates: number; maturedCandidates: number; selected: number; minDate: string | null; maxDate: string | null }>
    ) => {
      cohortPairs.forEach(([fromCohort, toCohort]) => {
        const key = ratioKey(fromCohort, toCohort);
        const sampled = filterRowsForRatioSampling({ rows: sourceRows, toCohort, maxDay });
        debugCollector[key] = sampled.debug;
        for (const row of sampled.rows) {
          const fromValue = row.revenueByCohort[fromCohort] ?? 0;
          const toValue = row.revenueByCohort[toCohort] ?? 0;
          if (fromValue > 0 && toValue > 0) {
            const entry = accumulator[row.os][key] ?? [];
            const rawRatio = toValue / fromValue;
            entry.push({
              ratio: clampHistoricalRatio(rawRatio, RATIO_PREDICTION_CONFIG.clampMin, RATIO_PREDICTION_CONFIG.clampMax),
              weight: Math.max(row.cost, 1)
            });
            accumulator[row.os][key] = entry;
          }
        }
      });
    };

    for (const row of heatmapRows) {
      const period = groupKeyFromRow(row);
      const current = periodAggregation.get(period) ?? {
        totalCost: 0,
        totalInstalls: 0,
        totalPayingUsers: 0,
        revenueByCohort: {},
        cohortCost: {},
        maturedCohortCost: {},
        osCost: {},
        osCountryCost: {},
        maxDay: row.day
      };
      current.totalCost += row.cost;
      current.totalInstalls += row.installs;
      current.totalPayingUsers += row.payingUsers;
      current.osCost[row.os] = (current.osCost[row.os] ?? 0) + row.cost;
      if (row.day > current.maxDay) current.maxDay = row.day;
      const osCountry = current.osCountryCost[row.os] ?? {};
      osCountry[row.country] = (osCountry[row.country] ?? 0) + row.cost;
      current.osCountryCost[row.os] = osCountry;

      for (const cohort of availableCohorts) {
        const daysNeeded = cohortWindowDays(cohort);
        const msNeeded = daysNeeded * 86400000;
        const isMatured = row.day.getTime() + msNeeded <= maxAvailableDay.getTime();
        current.revenueByCohort[cohort] =
          (current.revenueByCohort[cohort] ?? 0) + (row.revenueByCohort[cohort] ?? 0);
        current.cohortCost[cohort] = (current.cohortCost[cohort] ?? 0) + row.cost;
        if (isMatured) {
          current.maturedCohortCost[cohort] = (current.maturedCohortCost[cohort] ?? 0) + row.cost;
        }
      }

      periodAggregation.set(period, current);
    }
    const baseRowsForRatios = rows;
    const campaignRows =
      selectedCampaigns.length > 0
        ? baseRowsForRatios.filter((row) => selectedCampaigns.includes(row.campaign))
        : [];
    const networkRows =
      selectedNetworks.length > 0
        ? baseRowsForRatios.filter((row) => selectedNetworks.includes(row.network))
        : [];
    const countryRows =
      selectedCountries.length > 0
        ? baseRowsForRatios.filter((row) => selectedCountries.includes(row.country))
        : baseRowsForRatios;

    type SamplingDebug = {
      strategy: RatioSamplingStrategy;
      candidates: number;
      maturedCandidates: number;
      selected: number;
      minDate: string | null;
      maxDate: string | null;
    };
    const campaignSamplingDebug: Record<string, SamplingDebug> = {};
    const networkSamplingDebug: Record<string, SamplingDebug> = {};
    const globalSamplingDebug: Record<string, SamplingDebug> = {};
    const countrySamplingDebug: Record<string, Record<string, Record<string, SamplingDebug>>> = {
      android: {},
      ios: {},
      other: {}
    };

    accumulateRatios(campaignRows, campaignRatioAccumulator, maxAvailableDayGlobal, campaignSamplingDebug);
    accumulateRatios(networkRows, networkRatioAccumulator, maxAvailableDayGlobal, networkSamplingDebug);
    accumulateRatios(countryRows, osRatioAccumulator, maxAvailableDayGlobal, globalSamplingDebug);
    for (const row of countryRows) {
      const bucket = countryRatioAccumulator[row.os][row.country] ?? {};
      countryRatioAccumulator[row.os][row.country] = bucket;
    }
    (['android', 'ios', 'other'] as const).forEach((osKey) => {
      const countryList = Array.from(new Set(countryRows.filter((row) => row.os === osKey).map((row) => row.country)));
      countryList.forEach((country) => {
        const debugTarget: Record<string, SamplingDebug> = {};
        countrySamplingDebug[osKey][country] = debugTarget;
        const filtered = countryRows.filter((row) => row.os === osKey && row.country === country);
        const tempAcc: Record<string, Record<string, Array<{ ratio: number; weight: number }>>> = { android: {}, ios: {}, other: {} };
        accumulateRatios(filtered, tempAcc, maxAvailableDayGlobal, debugTarget);
        countryRatioAccumulator[osKey][country] = tempAcc[osKey];
      });
    });
    const periods = Array.from(periodAggregation.keys()).sort((a, b) => a.localeCompare(b));
    const costMap = new Map<string, number>();
    const installsMap = new Map<string, number>();
    const cpiMap = new Map<string, number | null>();
    const roasMap = new Map<string, number | null>();
    const ltvMap = new Map<string, number | null>();
    const predictedRoasMap = new Map<string, number | null>();
    const predictedMaskMap = new Map<string, boolean>();
    const maturityDiagnosticsRows: Array<{ period: string; cohort: string; matureCoverage: number }> = [];
    let currentMax = 0;

    const buildTrimmedAverages = (
      accumulator: Record<string, Record<string, Array<{ ratio: number; weight: number }>>>
    ): { values: Record<string, Record<string, number>>; counts: Record<string, Record<string, number>> } => {
      const values: Record<string, Record<string, number>> = { android: {}, ios: {}, other: {} };
      const counts: Record<string, Record<string, number>> = { android: {}, ios: {}, other: {} };
      (['android', 'ios', 'other'] as const).forEach((osKey) => {
        Object.entries(accumulator[osKey]).forEach(([key, samples]) => {
          const toCohort = key.split('=>')[1];
          const minSamples = getMinSamplesForRatio(toCohort);
          counts[osKey][key] = samples.length;
          if (samples.length < minSamples) return;
          const ratio = buildTrimmedWeightedMean(
            samples,
            RATIO_PREDICTION_CONFIG.trimPercent,
            RATIO_PREDICTION_CONFIG.trimMinKeepCount
          );
          if (ratio !== null) values[osKey][key] = ratio;
        });
      });
      return { values, counts };
    };

    const campaignStats = buildTrimmedAverages(campaignRatioAccumulator);
    const networkStats = buildTrimmedAverages(networkRatioAccumulator);
    const osGlobalStats = buildTrimmedAverages(osRatioAccumulator);
    const countryRatioAverages: Record<string, Record<string, Record<string, number>>> = {
      android: {},
      ios: {},
      other: {}
    };
    const countryRatioCounts: Record<string, Record<string, Record<string, number>>> = {
      android: {},
      ios: {},
      other: {}
    };
    const buildCountryTrimmed = (
      data: Record<string, Array<{ ratio: number; weight: number }>>,
      countTarget: Record<string, number>
    ): Record<string, number> => {
      const output: Record<string, number> = {};
      Object.entries(data).forEach(([key, samples]) => {
        const toCohort = key.split('=>')[1];
        const minSamples = getMinSamplesForRatio(toCohort);
        countTarget[key] = samples.length;
        if (samples.length < minSamples) return;
        const ratio = buildTrimmedWeightedMean(
          samples,
          RATIO_PREDICTION_CONFIG.trimPercent,
          RATIO_PREDICTION_CONFIG.trimMinKeepCount
        );
        if (ratio !== null) output[key] = ratio;
      });
      return output;
    };
    (['android', 'ios', 'other'] as const).forEach((osKey) => {
      Object.entries(countryRatioAccumulator[osKey]).forEach(([country, data]) => {
        const target = countryRatioCounts[osKey][country] ?? {};
        countryRatioCounts[osKey][country] = target;
        countryRatioAverages[osKey][country] = buildCountryTrimmed(data, target);
      });
    });

    const activeRatioSummary: Record<string, Record<string, number>> = {
      android: {},
      ios: {},
      other: {}
    };
    const periodJumpRatiosMap = new Map<string, Record<string, number>>();
    const ratioDebugEntries: Array<Record<string, unknown>> = [];

    periods.forEach((period) => {
      const values = periodAggregation.get(period);
      if (!values) return;
      costMap.set(period, values.totalCost);
      installsMap.set(period, values.totalInstalls);
      cpiMap.set(period, values.totalInstalls > 0 ? values.totalCost / values.totalInstalls : null);

      availableCohorts.forEach((cohort) => {
        const periodEnd =
          heatmapOrderBy === 'cohort_date' ? periodEndDate(period, granularity) : values.maxDay;
        const isFullPeriodMatured =
          periodEnd.getTime() + cohortWindowDays(cohort) * 86400000 <= maxAvailableDay.getTime();
        const revenue = values.revenueByCohort[cohort] ?? 0;
        const eligibleCost = values.cohortCost[cohort] ?? 0;
        const matureCoverage = eligibleCost > 0 ? (values.maturedCohortCost[cohort] ?? 0) / eligibleCost : 0;
        if (!isFullPeriodMatured && matureCoverage > 0 && matureCoverage < 1) {
          maturityDiagnosticsRows.push({ period, cohort, matureCoverage });
        }
        const roas = maturedOnly && !isFullPeriodMatured ? null : eligibleCost === 0 ? null : revenue / eligibleCost;
        roasMap.set(`${period}|||${cohort}`, roas);
        const installs = values.totalInstalls;
        const ltv = maturedOnly && !isFullPeriodMatured ? null : installs === 0 ? null : revenue / installs;
        ltvMap.set(`${period}|||${cohort}`, ltv);
        if (roas !== null) {
          currentMax = Math.max(currentMax, roas);
        }
      });

      const osTotal = values.totalCost || 1;
      const periodRatios: Record<string, number> = {};
      cohortPairs.forEach(([fromCohort, toCohort]) => {
        const key = ratioKey(fromCohort, toCohort);
        let blended = 0;
        let usedWeight = 0;
        const minSamples = getMinSamplesForRatio(toCohort);
        (['android', 'ios', 'other'] as const).forEach((osKey) => {
          const weight = (values.osCost[osKey] ?? 0) / osTotal;
          const countryCostMap = values.osCountryCost[osKey] ?? {};
          const topCountry =
            Object.entries(countryCostMap).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';
          const campaignLevel = {
            value: campaignStats.values[osKey][key] ?? null,
            count: campaignStats.counts[osKey][key] ?? 0
          };
          const networkLevel = {
            value: networkStats.values[osKey][key] ?? null,
            count: networkStats.counts[osKey][key] ?? 0
          };
          const countryLevel = {
            value: enableCountryFallback ? countryRatioAverages[osKey][topCountry]?.[key] ?? null : null,
            count: enableCountryFallback ? countryRatioCounts[osKey][topCountry]?.[key] ?? 0 : 0
          };
          const globalLevel = {
            value: osGlobalStats.values[osKey][key] ?? null,
            count: osGlobalStats.counts[osKey][key] ?? 0
          };
          const blendedResolved = resolveBlendedFallbackRatio({
            campaign: campaignLevel,
            network: networkLevel,
            country: countryLevel,
            global: globalLevel,
            minSamples
          });
          const guarded = applyLateStageFlatlineGuard({
            ratio: blendedResolved.ratio,
            toCohort,
            flatlineThreshold: RATIO_PREDICTION_CONFIG.lateFlatlineThreshold,
            recentEvidenceAvg: globalLevel.value,
            recentEvidenceCount: globalLevel.count,
            minSamples,
            evidenceMinAvg: RATIO_PREDICTION_CONFIG.lateEvidenceMinAvg
          });
          const ratio = guarded.ratio;
          ratioDebugEntries.push({
            period,
            os: osKey,
            ratioKey: key,
            stage: getRatioStage(toCohort),
            sampling: {
              campaign: campaignSamplingDebug[key] ?? null,
              network: networkSamplingDebug[key] ?? null,
              country: countrySamplingDebug[osKey][topCountry]?.[key] ?? null,
              global: globalSamplingDebug[key] ?? null
            },
            method: 'trimmed_weighted_mean',
            minSamples,
            counts: {
              campaign: campaignLevel.count,
              network: networkLevel.count,
              country: countryLevel.count,
              global: globalLevel.count
            },
            levelRatios: {
              campaign: campaignLevel.value,
              network: networkLevel.value,
              country: countryLevel.value,
              global: globalLevel.value
            },
            ratioFinal: ratio,
            blendApplied: blendedResolved.blendApplied,
            flatlineGuardApplied: guarded.applied,
            clampApplied: true
          });
          if (ratio) {
            blended += ratio * weight;
            usedWeight += weight;
            activeRatioSummary[osKey][key] = ratio;
          }
        });
        if (usedWeight > 0) {
          periodRatios[key] = blended / usedWeight;
        }
      });
      periodJumpRatiosMap.set(period, periodRatios);

      availableCohorts.forEach((cohort, cohortIndex) => {
        const cellKey = `${period}|||${cohort}`;
        const actualValue = roasMap.get(cellKey) ?? null;
        if (actualValue !== null) {
          predictedRoasMap.set(cellKey, actualValue);
          predictedMaskMap.set(cellKey, false);
          return;
        }

        let estimated: number | null = null;
        for (let prevIndex = cohortIndex - 1; prevIndex >= 0; prevIndex -= 1) {
          const prevCohort = availableCohorts[prevIndex];
          const prevValue = predictedRoasMap.get(`${period}|||${prevCohort}`) ?? roasMap.get(`${period}|||${prevCohort}`) ?? null;
          if (prevValue === null) {
            continue;
          }
          let projection = prevValue;
          let canProject = true;
          for (let stepIndex = prevIndex; stepIndex < cohortIndex; stepIndex += 1) {
            const fromCohort = availableCohorts[stepIndex];
            const toCohort = availableCohorts[stepIndex + 1];
            const stepRatio = periodRatios[ratioKey(fromCohort, toCohort)];
            if (!stepRatio) {
              canProject = false;
              break;
            }
            projection *= stepRatio;
          }
          if (canProject) {
            estimated = projection;
            break;
          }
        }

        predictedRoasMap.set(cellKey, estimated);
        predictedMaskMap.set(cellKey, estimated !== null);
        if (estimated !== null) {
          currentMax = Math.max(currentMax, estimated);
        }
      });
    });

    return {
      orderedPeriods: periods,
      periodCost: costMap,
      periodInstalls: installsMap,
      periodCpi: cpiMap,
      periodRoas: roasMap,
      periodLtv: ltvMap,
      predictedRoas: predictedRoasMap,
      predictedMask: predictedMaskMap,
      ratioSummary: activeRatioSummary,
      periodJumpRatios: periodJumpRatiosMap,
      ratioDebugInfo: ratioDebugEntries,
      maxRoas: currentMax,
      maturityDiagnostics: maturityDiagnosticsRows.slice(0, 8)
    };
  }, [rows, heatmapRows, heatmapOrderBy, granularity, availableCohorts, maturedOnly, selectedCampaigns, selectedNetworks, selectedCountries, enableCountryFallback]);

  const predictedLtv = useMemo(() => {
    const out = new Map<string, number | null>();
    orderedPeriods.forEach((period) => {
      const cpi = periodCpi.get(period) ?? null;
      availableCohorts.forEach((cohort) => {
        const key = `${period}|||${cohort}`;
        const roas = predictedRoas.get(key) ?? null;
        out.set(key, roas === null || cpi === null ? null : roas * cpi);
      });
    });
    return out;
  }, [orderedPeriods, availableCohorts, predictedRoas, periodCpi]);

  const retainedUsersData = useMemo(() => {
    const periodRetentionActual = new Map<string, number | null>();
    const periodRetentionResolved = new Map<string, number | null>();
    const periodRetentionPredictedMask = new Map<string, boolean>();
    const periodRetainedUsers = new Map<string, number | null>();
    const periodRevenueLeft = new Map<string, number>();

    const globalAcc: Record<string, { weighted: number; installs: number }> = {};
    const osAcc: Record<string, Record<string, { weighted: number; installs: number }>> = { android: {}, ios: {}, other: {} };
    const countryAcc: Record<string, Record<string, { weighted: number; installs: number }>> = {};
    const organicCountryAcc: Record<string, Record<string, { weighted: number; installs: number }>> = {};
    const networkHistoricalAcc: Record<string, { weighted: number; installs: number }> = {};
    const periodAcc: Record<string, Record<string, { weighted: number; installs: number }>> = {};
    const periodCountryCost: Record<string, Record<string, number>> = {};
    const periodOsCost: Record<string, Record<string, number>> = {};

    const addSample = (target: Record<string, { weighted: number; installs: number }>, cohort: string, rate: number, installs: number) => {
      const current = target[cohort] ?? { weighted: 0, installs: 0 };
      current.weighted += rate * installs;
      current.installs += installs;
      target[cohort] = current;
    };

    for (const row of heatmapRows) {
      const period = periodKey(row.day, granularity);
      periodAcc[period] = periodAcc[period] ?? {};
      periodCountryCost[period] = periodCountryCost[period] ?? {};
      periodOsCost[period] = periodOsCost[period] ?? {};
      periodCountryCost[period][row.country] = (periodCountryCost[period][row.country] ?? 0) + row.cost;
      periodOsCost[period][row.os] = (periodOsCost[period][row.os] ?? 0) + row.cost;
      countryAcc[row.country] = countryAcc[row.country] ?? {};

      for (const cohort of availableRetentionCohorts) {
        const value = row.retentionByCohort[cohort];
        if (!Number.isFinite(value) || value <= 0 || row.installs <= 0) continue;
        addSample(globalAcc, cohort, value, row.installs);
        addSample(periodAcc[period], cohort, value, row.installs);
        addSample(osAcc[row.os], cohort, value, row.installs);
        addSample(countryAcc[row.country], cohort, value, row.installs);
      }
    }

    for (const row of organicRetentionRows) {
      organicCountryAcc[row.country] = organicCountryAcc[row.country] ?? {};
      for (const cohort of availableRetentionCohorts) {
        const value = row.retentionByCohort[cohort];
        if (!Number.isFinite(value) || value <= 0 || row.installs <= 0) continue;
        addSample(organicCountryAcc[row.country], cohort, value, row.installs);
      }
    }

    for (const row of networkHistoricalRetentionRows) {
      for (const cohort of availableRetentionCohorts) {
        const value = row.retentionByCohort[cohort];
        if (!Number.isFinite(value) || value <= 0 || row.installs <= 0) continue;
        addSample(networkHistoricalAcc, cohort, value, row.installs);
      }
    }

    const average = (bucket?: { weighted: number; installs: number }): number | null =>
      !bucket || bucket.installs <= 0 ? null : bucket.weighted / bucket.installs;

    for (const period of orderedPeriods) {
      const installs = periodInstalls.get(period) ?? 0;
      const topOs = Object.entries(periodOsCost[period] ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
      const topCountry = Object.entries(periodCountryCost[period] ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      const periodCountries = Object.keys(periodCountryCost[period] ?? {});
      let previousResolvedRate: number | null = null;

      for (const cohort of availableRetentionCohorts) {
        const key = `${period}|||${cohort}`;
        const actual = average(periodAcc[period]?.[cohort]);
        periodRetentionActual.set(key, actual);
        if (actual !== null) {
          periodRetentionResolved.set(key, actual);
          periodRetentionPredictedMask.set(key, false);
          periodRetainedUsers.set(key, installs > 0 ? actual * installs : null);
          previousResolvedRate = actual;
          continue;
        }
        const organicCountryFallback = periodCountries.length > 0
          ? periodCountries.reduce(
              (acc, country) => {
                const avg = average(organicCountryAcc[country]?.[cohort]);
                if (avg === null) return acc;
                const weight = (periodCountryCost[period]?.[country] ?? 0) || 1;
                return { weighted: acc.weighted + avg * weight, weight: acc.weight + weight };
              },
              { weighted: 0, weight: 0 }
            )
          : { weighted: 0, weight: 0 };
        const organicResolved =
          organicCountryFallback.weight > 0 ? organicCountryFallback.weighted / organicCountryFallback.weight : null;

        let fallback = enablePrediction
          ? average(networkHistoricalAcc[cohort]) ??
            organicResolved ??
            average(osAcc[topOs]?.[cohort]) ??
            (enableCountryFallback && topCountry ? average(countryAcc[topCountry]?.[cohort]) : null) ??
            average(globalAcc[cohort])
          : null;
        if (cohortWindowDays(cohort) > 120) {
          fallback = null;
        }
        if (fallback !== null && previousResolvedRate !== null) {
          fallback = Math.min(fallback, previousResolvedRate);
        }
        periodRetentionResolved.set(key, fallback);
        periodRetentionPredictedMask.set(key, fallback !== null);
        periodRetainedUsers.set(key, fallback !== null && installs > 0 ? fallback * installs : null);
        if (fallback !== null) {
          previousResolvedRate = fallback;
        }
      }

      const bestRoas = availableCohorts.reduce((max, cohort) => {
        const key = `${period}|||${cohort}`;
        const value = enablePrediction ? predictedRoas.get(key) ?? null : periodRoas.get(key) ?? null;
        return value !== null && value > max ? value : max;
      }, 0);
      const recoveredRevenue = (periodCost.get(period) ?? 0) * bestRoas;
      periodRevenueLeft.set(period, Math.max((periodCost.get(period) ?? 0) - recoveredRevenue, 0));
    }

    return { periodRetentionActual, periodRetentionResolved, periodRetentionPredictedMask, periodRetainedUsers, periodRevenueLeft };
  }, [
    heatmapRows,
    granularity,
    availableRetentionCohorts,
    orderedPeriods,
    periodInstalls,
    enablePrediction,
    enableCountryFallback,
    periodRoas,
    predictedRoas,
    availableCohorts,
    periodCost,
    organicRetentionRows,
    networkHistoricalRetentionRows
  ]);

  const cohortPairs = useMemo(
    () => availableCohorts.slice(0, -1).map((cohort, index) => [cohort, availableCohorts[index + 1]] as const),
    [availableCohorts]
  );

  const periodRevenueByPeriod = useMemo(() => {
    const periodRevenue = new Map<string, Record<string, number>>();
    const maxAvailableDay = heatmapRows.reduce((max, row) => (row.day > max ? row.day : max), new Date(0));

    for (const row of heatmapRows) {
      const period = periodKey(row.day, granularity);
      const current = periodRevenue.get(period) ?? {};

      for (const cohort of availableCohorts) {
        const daysNeeded = cohortWindowDays(cohort);
        const isMatured = row.day.getTime() + daysNeeded * 86400000 <= maxAvailableDay.getTime();
        if (!maturedOnly || isMatured) {
          current[cohort] = (current[cohort] ?? 0) + (row.revenueByCohort[cohort] ?? 0);
        }
      }
      periodRevenue.set(period, current);
    }
    return periodRevenue;
  }, [heatmapRows, availableCohorts, granularity, maturedOnly]);

  const ratioEvolutionRows = useMemo(() => {
    return Array.from(periodRevenueByPeriod.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, revenues]) => {
        const ratios: Record<string, number | null> = {};
        const predicted: Record<string, boolean> = {};
        const fallbackRatios = periodJumpRatios.get(period) ?? {};
        for (const [from, to] of cohortPairs) {
          const key = ratioKey(from, to);
          const fromValue = revenues[from] ?? 0;
          const toValue = revenues[to] ?? 0;
          const realRatio = fromValue > 0 && toValue > 0 ? toValue / fromValue : null;
          if (realRatio !== null && realRatio >= 1) {
            ratios[key] = realRatio;
            predicted[key] = false;
            continue;
          }
          const predictedRatio = enablePrediction ? fallbackRatios[key] ?? null : null;
          ratios[key] = predictedRatio !== null && predictedRatio >= 1 ? predictedRatio : null;
          predicted[key] = ratios[key] !== null;
        }
        return { period, ratios, predicted };
      });
  }, [periodRevenueByPeriod, enablePrediction, periodJumpRatios, cohortPairs]);

  const periodDistributionRatios = useMemo(() => {
    return Array.from(periodRevenueByPeriod.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, revenues]) => {
        const denominator =
          [...availableCohorts]
            .reverse()
            .map((cohort) => revenues[cohort] ?? null)
            .find((value): value is number => value !== null && value > 0) ?? null;
        const ratios: Record<string, number | null> = {};
        for (const [from, to] of cohortPairs) {
          const key = ratioKey(from, to);
          const fromValue = revenues[from] ?? null;
          const toValue = revenues[to] ?? null;
          if (denominator === null || fromValue === null || toValue === null) {
            ratios[key] = null;
            continue;
          }
          const bucketRevenue = toValue - fromValue;
          ratios[key] = bucketRevenue >= 0 && denominator > 0 ? bucketRevenue / denominator : null;
        }
        return { period, ratios, denominator };
      });
  }, [periodRevenueByPeriod, availableCohorts, cohortPairs]);

  const roasEvolutionSeries = useMemo(() => {
    const visiblePeriods = orderedPeriods.slice(-8);
    return visiblePeriods.map((period, index) => ({
      ...buildChartTone(index, visiblePeriods.length),
      key: period,
      label: period,
      values: availableCohorts.map((cohort) => {
        const key = `${period}|||${cohort}`;
        return enablePrediction ? predictedRoas.get(key) ?? null : periodRoas.get(key) ?? null;
      }),
      predicted: availableCohorts.map((cohort) => {
        const key = `${period}|||${cohort}`;
        return enablePrediction ? predictedMask.get(key) ?? false : false;
      })
    }));
  }, [orderedPeriods, availableCohorts, enablePrediction, predictedRoas, periodRoas, predictedMask]);

  const ratioChartSeries = useMemo(() => {
    const pairs = availableCohorts.slice(0, -1).map((from, index) => [from, availableCohorts[index + 1]] as const);
    return pairs.map(([from, to], index) => {
      const key = ratioKey(from, to);
      return {
        ...buildChartTone(index, pairs.length),
        key,
        label: `${normalizeCohortLabel(from)}→${normalizeCohortLabel(to)}`,
        values: ratioEvolutionRows.map((row) => row.ratios[key] ?? null),
        predicted: ratioEvolutionRows.map((row) => row.predicted[key] ?? false)
      };
    });
  }, [availableCohorts, ratioEvolutionRows]);

  const bottomChartSeries = bottomChartMode === 'roas' ? roasEvolutionSeries : ratioChartSeries;
  const roasVisibleCohorts = useMemo(
    () => availableCohorts.filter((_, index) => roasEvolutionSeries.some((series) => series.values[index] !== null)),
    [availableCohorts, roasEvolutionSeries]
  );
  const chartPointCount = bottomChartMode === 'roas' ? roasVisibleCohorts.length : ratioEvolutionRows.length;

  useEffect(() => {
    setSelectedRatioKeys(bottomChartSeries.map((series) => series.key));
  }, [bottomChartSeries, bottomChartMode]);

  useEffect(() => {
    (globalThis as Record<string, unknown>).__ratioDebug = ratioDebugInfo;
  }, [ratioDebugInfo]);

  const chartWidth = 1180;
  const chartHeight = mainViewTab === 'graficos' ? 520 : 420;
  const chartPadding = { top: 24, right: 24, bottom: 62, left: 58 };
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right;
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const activeSeries = bottomChartSeries.filter((series) => selectedRatioKeys.includes(series.key));
  const maxRatioValue = Math.max(
    bottomChartMode === 'roas' ? 1 : 1.2,
    ...activeSeries.flatMap((series) => series.values.filter((value): value is number => value !== null))
  );
  const ratioYTicks = [0, 1, 2, 3, 4, 5].map((tick) => ({
    y: chartPadding.top + (plotHeight * tick) / 5,
    value: maxRatioValue * (1 - tick / 5)
  }));
  const hoveredRatioDetails = useMemo(() => {
    if (hoveredRatioIndex === null) return null;
    const xLabel =
      bottomChartMode === 'roas'
        ? normalizeCohortLabel(roasVisibleCohorts[hoveredRatioIndex] ?? '')
        : ratioEvolutionRows[hoveredRatioIndex]?.period ?? '';
    if (!xLabel) return null;
    const roasIndex = bottomChartMode === 'roas' ? availableCohorts.indexOf(roasVisibleCohorts[hoveredRatioIndex] ?? '') : -1;
    return {
      xLabel,
      details: activeSeries
        .map((series) => ({
          label: series.label,
          color: series.color,
          value: bottomChartMode === 'roas' ? (roasIndex >= 0 ? series.values[roasIndex] : null) : series.values[hoveredRatioIndex],
          predicted: bottomChartMode === 'roas' ? (roasIndex >= 0 ? series.predicted[roasIndex] ?? false : false) : series.predicted[hoveredRatioIndex] ?? false
        }))
        .filter((entry): entry is { label: string; color: string; value: number; predicted: boolean } => entry.value !== null)
    };
  }, [hoveredRatioIndex, availableCohorts, activeSeries, bottomChartMode, ratioEvolutionRows, roasVisibleCohorts]);
  const hoveredRatioX = useMemo(() => {
    if (hoveredRatioIndex === null || chartPointCount === 0) return null;
    return chartPadding.left + (plotWidth * hoveredRatioIndex) / Math.max(chartPointCount - 1, 1);
  }, [hoveredRatioIndex, chartPointCount, chartPadding.left, plotWidth]);
  const heatmapRowLabel =
    heatmapOrderBy === 'cohort_date'
      ? 'Cohort date'
      : heatmapOrderBy === 'os'
        ? 'OS'
        : heatmapOrderBy === 'country'
          ? 'Country'
          : heatmapOrderBy === 'network'
            ? 'Network'
            : 'Campaign';

  const overviewMetrics = useMemo(() => {
    const cohortByDay = (targetDay: number) => availableCohorts.find((cohort) => cohortWindowDays(cohort) === targetDay) ?? null;
    const cohortD7 = cohortByDay(7);
    const cohortD14 = cohortByDay(14);
    const cohortD30 = cohortByDay(30);
    const cohortD180 = cohortByDay(180);
    const roasAverageFor = (cohort: string | null): number | null => {
      if (!cohort) return null;
      const values = orderedPeriods
        .map((period) => periodRoas.get(`${period}|||${cohort}`) ?? null)
        .filter((value): value is number => value !== null);
      if (values.length === 0) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };

    const spendTotal = orderedPeriods.reduce((sum, period) => sum + (periodCost.get(period) ?? 0), 0);
    const installsTotal = orderedPeriods.reduce((sum, period) => sum + (periodInstalls.get(period) ?? 0), 0);
    const cpiAverage = installsTotal > 0 ? spendTotal / installsTotal : null;
    const roasD7 = roasAverageFor(cohortD7);
    const roasD14 = roasAverageFor(cohortD14);
    const roasD30 = roasAverageFor(cohortD30);

    const recoveredPeriods = cohortD180
      ? orderedPeriods.filter((period) => {
          const roas180 = periodRoas.get(`${period}|||${cohortD180}`) ?? null;
          return roas180 !== null && roas180 >= 1;
        })
      : [];

    const paybackWindows = recoveredPeriods
      .map((period) => {
        const recoveredDay = availableCohorts
          .slice()
          .sort((a, b) => cohortWindowDays(a) - cohortWindowDays(b))
          .find((cohort) => {
            const value = periodRoas.get(`${period}|||${cohort}`) ?? null;
            return value !== null && value >= 1;
          });
        return recoveredDay ? cohortWindowDays(recoveredDay) : null;
      })
      .filter((value): value is number => value !== null);

    const paybackWindowAverage =
      paybackWindows.length > 0
        ? paybackWindows.reduce((sum, value) => sum + value, 0) / paybackWindows.length
        : null;

    const targetD7ForPositiveD180 =
      cohortD7 && recoveredPeriods.length > 0
        ? recoveredPeriods
            .map((period) => periodRoas.get(`${period}|||${cohortD7}`) ?? null)
            .filter((value): value is number => value !== null)
        : [];
    const targetRoasD7 =
      targetD7ForPositiveD180.length > 0
        ? targetD7ForPositiveD180.reduce((sum, value) => sum + value, 0) / targetD7ForPositiveD180.length
        : null;

    const buildTrend = (resolver: (period: string) => number | null): Array<number | null> =>
      orderedPeriods.map((period) => resolver(period));
    const latestVsPrevious = (values: Array<number | null>): { latest: number | null; previous: number | null; deltaPct: number | null } => {
      const valid = values.filter((value): value is number => value !== null);
      if (valid.length === 0) return { latest: null, previous: null, deltaPct: null };
      const latest = valid[valid.length - 1];
      const previous = valid[valid.length - 2] ?? null;
      if (compareMode === 'none' || previous === null || previous === 0) {
        return { latest, previous, deltaPct: null };
      }
      return { latest, previous, deltaPct: ((latest - previous) / previous) * 100 };
    };

    const metricsTrend = {
      roasD7: buildTrend((period) => (cohortD7 ? periodRoas.get(`${period}|||${cohortD7}`) ?? null : null)),
      roasD14: buildTrend((period) => (cohortD14 ? periodRoas.get(`${period}|||${cohortD14}`) ?? null : null)),
      roasD30: buildTrend((period) => (cohortD30 ? periodRoas.get(`${period}|||${cohortD30}`) ?? null : null)),
      spend: buildTrend((period) => periodCost.get(period) ?? null),
      cpi: buildTrend((period) => periodCpi.get(period) ?? null),
      payback: buildTrend((period) => {
        if (!cohortD180) return null;
        const roas180 = periodRoas.get(`${period}|||${cohortD180}`) ?? null;
        if (roas180 === null || roas180 < 1) return null;
        const recoveredDay = availableCohorts
          .slice()
          .sort((a, b) => cohortWindowDays(a) - cohortWindowDays(b))
          .find((cohort) => {
            const value = periodRoas.get(`${period}|||${cohort}`) ?? null;
            return value !== null && value >= 1;
          });
        return recoveredDay ? cohortWindowDays(recoveredDay) : null;
      })
    };

    return {
      roasD7,
      roasD14,
      roasD30,
      spendTotal,
      cpiAverage,
      paybackWindowAverage,
      targetRoasD7,
      recoveredCount: recoveredPeriods.length,
      trends: metricsTrend,
      deltas: {
        roasD7: latestVsPrevious(metricsTrend.roasD7),
        roasD14: latestVsPrevious(metricsTrend.roasD14),
        roasD30: latestVsPrevious(metricsTrend.roasD30),
        spend: latestVsPrevious(metricsTrend.spend),
        cpi: latestVsPrevious(metricsTrend.cpi),
        payback: latestVsPrevious(metricsTrend.payback)
      }
    };
  }, [availableCohorts, orderedPeriods, periodCost, periodInstalls, periodRoas, periodCpi, compareMode]);

  const activeFallbackLabels = useMemo(() => {
    const latestPeriod = orderedPeriods[orderedPeriods.length - 1] ?? null;
    const fallbackMap: Record<string, Record<string, string>> = { android: {}, ios: {}, other: {} };
    ratioDebugInfo.forEach((entry) => {
      const period = String((entry.period as string) ?? '');
      if (latestPeriod && period !== latestPeriod) return;
      const os = String((entry.os as string) ?? '').toLowerCase();
      const pair = String((entry.ratioKey as string) ?? '');
      if (!(os in fallbackMap) || !pair) return;
      const counts = (entry.counts as Record<string, number> | undefined) ?? {};
      const minSamples = Number((entry.minSamples as number | undefined) ?? 6);
      let label = 'global';
      if ((counts.campaign ?? 0) >= minSamples) label = 'campaña + blend';
      else if ((counts.network ?? 0) >= minSamples) label = 'network + blend';
      else if (enableCountryFallback && (counts.country ?? 0) >= minSamples) label = 'país + blend';
      fallbackMap[os as 'android' | 'ios' | 'other'][pair] = label;
    });
    return fallbackMap;
  }, [ratioDebugInfo, orderedPeriods, enableCountryFallback]);

  function handleRatioMouseMove(event: ReactMouseEvent<SVGSVGElement>): void {
    if (chartPointCount === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const relativeX = (pointerX / bounds.width) * chartWidth;
    const isInsidePlot = relativeX >= chartPadding.left && relativeX <= chartWidth - chartPadding.right;
    if (!isInsidePlot) {
      setHoveredRatioIndex(null);
      return;
    }
    const clampedX = Math.min(Math.max(relativeX, chartPadding.left), chartWidth - chartPadding.right);
    const ratio = (clampedX - chartPadding.left) / Math.max(plotWidth, 1);
    const nextIndex = Math.round(ratio * Math.max(chartPointCount - 1, 0));
    const pointX = chartPadding.left + (plotWidth * nextIndex) / Math.max(chartPointCount - 1, 1);
    const hoverTolerance = Math.max(36, plotWidth / Math.max((chartPointCount - 1) * 2.2, 1));
    if (Math.abs(clampedX - pointX) > hoverTolerance) {
      setHoveredRatioIndex(null);
      return;
    }
    setHoveredRatioIndex(nextIndex);
  }

  const renderSparkline = (values: Array<number | null>, color: string) => {
    const numeric = values.filter((value): value is number => value !== null);
    if (numeric.length < 2) return null;
    const min = Math.min(...numeric);
    const max = Math.max(...numeric);
    const scale = max - min || 1;
    const points = values
      .map((value, index) => {
        if (value === null) return null;
        const x = (index / Math.max(values.length - 1, 1)) * 100;
        const y = 100 - ((value - min) / scale) * 100;
        return `${x},${y}`;
      })
      .filter((value): value is string => value !== null);
    if (points.length < 2) return null;
    return (
      <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="3.2" />
      </svg>
    );
  };

  return (
    <main className="layout">
      <aside className="filters">
        <div className="brandBlock">
          <h1>ROAS Intelligence</h1>
          <p>Panel operativo</p>
        </div>

        <div className="leftNav">
          <button className="leftNavItem active" type="button">
            Vista General
          </button>
        </div>

        <div className="titleRow">
          <h2>Filtros</h2>
          <button className="modeBtn" type="button" onClick={() => setIsDarkMode((current) => !current)}>
            {isDarkMode ? 'Light mode' : 'Dark mode'}
          </button>
        </div>

        <label>
          Tipo de fecha
          <select value={granularity} onChange={(event) => setGranularity(event.target.value as Granularity)}>
            <option value="daily">Diario</option>
            <option value="weekly">Semanal</option>
            <option value="monthly">Mensual</option>
          </select>
        </label>

        <label>
          Order by (heatmap/pred)
          <select value={heatmapOrderBy} onChange={(event) => setHeatmapOrderBy(event.target.value as HeatmapOrderBy)}>
            <option value="cohort_date">Cohort date</option>
            <option value="os">OS</option>
            <option value="country">Country</option>
            <option value="network">Network</option>
            <option value="campaign">Campaign</option>
          </select>
        </label>

        <label>
          Quick date selector
          <select value={quickDatePreset} onChange={(event) => setQuickDatePreset(event.target.value as QuickDatePreset)}>
            <option value="all_time">All time</option>
            <option value="last_5_months">Last 5 months</option>
            <option value="last_3_months">Last 3 months</option>
            <option value="last_2_months">Last 2 months</option>
            <option value="last_month">Last month</option>
            <option value="this_month">This month</option>
            <option value="last_30_days">Last 30 days</option>
            <option value="last_14_days">Last 14 days</option>
            <option value="last_7_days">Last 7 days</option>
            <option value="yesterday">Yesterday</option>
            <option value="custom">Custom (use start/end date)</option>
          </select>
        </label>

        <label>
          Fecha desde
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>

        <label>
          Fecha hasta
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>

        <label>
          Cargar CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                handleCsvUpload(file);
              }
            }}
          />
        </label>

        <p className="sourceInfo">Fuente: {dataSourceLabel}</p>
        {loadError && <p className="errorInfo">{loadError}</p>}

        <MultiSelect title="Sistema operativo" options={osOptions} selected={selectedOs} onChange={setSelectedOs} />

        <MultiSelect title="País" options={countryOptions} selected={selectedCountries} onChange={setSelectedCountries} searchable />

        <MultiSelect
          title="Network"
          options={networkOptions}
          selected={selectedNetworks}
          onChange={setSelectedNetworks}
          searchable
        />

        <MultiSelect
          title="Campaña"
          options={campaignOptions}
          selected={selectedCampaigns}
          onChange={setSelectedCampaigns}
          searchable
        />

        <label className="toggleRow">
          <input type="checkbox" checked={maturedOnly} onChange={(event) => setMaturedOnly(event.target.checked)} />
          <span>Maturated cohorts only? (full windows)</span>
        </label>

        <label className="toggleRow">
          <input
            type="checkbox"
            checked={enablePrediction}
            onChange={(event) => setEnablePrediction(event.target.checked)}
          />
          <span>Enable prediction</span>
        </label>

        <label className="toggleRow">
          <input
            type="checkbox"
            checked={enableCountryFallback}
            onChange={(event) => setEnableCountryFallback(event.target.checked)}
          />
          <span>Predicción por país?</span>
        </label>
      </aside>

      <section className="heatmapWrap">
        {rows.length === 0 && (
          <p className="errorInfo">
            No hay datos cargados. Coloca <code>Campaign data.csv</code> dentro de <code>public/</code> o súbelo con
            el selector.
          </p>
        )}
        <div className="overviewHero">
          <h2>Vista General</h2>
          <p>Rendimiento agregado de campañas y cohorts</p>
        </div>
        <div className="viewTabs">
          <button
            type="button"
            className={`viewTabBtn ${mainViewTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setMainViewTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={`viewTabBtn ${mainViewTab === 'graficos' ? 'active' : ''}`}
            onClick={() => setMainViewTab('graficos')}
          >
            Gráficos
          </button>
        </div>

        {mainViewTab === 'dashboard' && (
          <>
        <div className="metricsGrid">
          <article className="metricCard">
            <span>ROAS D7</span>
            <strong>{overviewMetrics.roasD7 === null ? 'N/A' : `${(overviewMetrics.roasD7 * 100).toFixed(1)}%`}</strong>
            <em className={overviewMetrics.deltas.roasD7.deltaPct !== null && overviewMetrics.deltas.roasD7.deltaPct >= 0 ? 'kpiUp' : 'kpiDown'}>
              {overviewMetrics.deltas.roasD7.deltaPct === null ? 'sin comparación' : `${overviewMetrics.deltas.roasD7.deltaPct >= 0 ? '↑' : '↓'} ${Math.abs(overviewMetrics.deltas.roasD7.deltaPct).toFixed(1)}%`}
            </em>
            {renderSparkline(overviewMetrics.trends.roasD7, '#37d1ff')}
          </article>
          <article className="metricCard">
            <span>ROAS D14</span>
            <strong>{overviewMetrics.roasD14 === null ? 'N/A' : `${(overviewMetrics.roasD14 * 100).toFixed(1)}%`}</strong>
            <em className={overviewMetrics.deltas.roasD14.deltaPct !== null && overviewMetrics.deltas.roasD14.deltaPct >= 0 ? 'kpiUp' : 'kpiDown'}>
              {overviewMetrics.deltas.roasD14.deltaPct === null ? 'sin comparación' : `${overviewMetrics.deltas.roasD14.deltaPct >= 0 ? '↑' : '↓'} ${Math.abs(overviewMetrics.deltas.roasD14.deltaPct).toFixed(1)}%`}
            </em>
            {renderSparkline(overviewMetrics.trends.roasD14, '#63e1b0')}
          </article>
          <article className="metricCard">
            <span>ROAS D30</span>
            <strong>{overviewMetrics.roasD30 === null ? 'N/A' : `${(overviewMetrics.roasD30 * 100).toFixed(1)}%`}</strong>
            <em className={overviewMetrics.deltas.roasD30.deltaPct !== null && overviewMetrics.deltas.roasD30.deltaPct >= 0 ? 'kpiUp' : 'kpiDown'}>
              {overviewMetrics.deltas.roasD30.deltaPct === null ? 'sin comparación' : `${overviewMetrics.deltas.roasD30.deltaPct >= 0 ? '↑' : '↓'} ${Math.abs(overviewMetrics.deltas.roasD30.deltaPct).toFixed(1)}%`}
            </em>
            {renderSparkline(overviewMetrics.trends.roasD30, '#9d8bff')}
          </article>
          <article className="metricCard">
            <span>Spend total</span>
            <strong>{overviewMetrics.spendTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
            <em className={overviewMetrics.deltas.spend.deltaPct !== null && overviewMetrics.deltas.spend.deltaPct >= 0 ? 'kpiUp' : 'kpiDown'}>
              {overviewMetrics.deltas.spend.deltaPct === null ? 'sin comparación' : `${overviewMetrics.deltas.spend.deltaPct >= 0 ? '↑' : '↓'} ${Math.abs(overviewMetrics.deltas.spend.deltaPct).toFixed(1)}%`}
            </em>
            {renderSparkline(overviewMetrics.trends.spend, '#b884ff')}
          </article>
          <article className="metricCard">
            <span>CPI</span>
            <strong>{overviewMetrics.cpiAverage === null ? 'N/A' : overviewMetrics.cpiAverage.toFixed(3)}</strong>
            <em className={overviewMetrics.deltas.cpi.deltaPct !== null && overviewMetrics.deltas.cpi.deltaPct <= 0 ? 'kpiUp' : 'kpiDown'}>
              {overviewMetrics.deltas.cpi.deltaPct === null ? 'sin comparación' : `${overviewMetrics.deltas.cpi.deltaPct <= 0 ? '↓' : '↑'} ${Math.abs(overviewMetrics.deltas.cpi.deltaPct).toFixed(1)}%`}
            </em>
            {renderSparkline(overviewMetrics.trends.cpi, '#f857a6')}
          </article>
          <article className="metricCard">
            <span>Payback Window</span>
            <strong>{overviewMetrics.paybackWindowAverage === null ? 'N/A' : `${Math.round(overviewMetrics.paybackWindowAverage)} días`}</strong>
            <em>{overviewMetrics.recoveredCount > 0 ? `${overviewMetrics.recoveredCount} cohorts recuperados` : 'Sin cohorts recuperados'}</em>
            {renderSparkline(overviewMetrics.trends.payback, '#5ed37c')}
          </article>
          <article className="metricCard metricCardWide">
            <span>Target ROAS D7 for D180 positive ROI</span>
            <strong>{overviewMetrics.targetRoasD7 === null ? 'N/A' : `${(overviewMetrics.targetRoasD7 * 100).toFixed(1)}%`}</strong>
            <em>Promedio D7 tomado solo de cohorts recuperados en D180</em>
          </article>
        </div>
        <p className="legend">
          Tabla heatmap: primera columna según Order by, luego Ad spend, Installs, CPI y ROAS en porcentaje por
          cohort (D0, D3, D7, etc). Con &quot;Maturated cohorts only?&quot; activo, solo se muestran ventanas
          completas.
        </p>
        <div className="dualHeatmapGrid">
          <div>
            <p className="tableTitle">ROAS Heatmap por Cohort</p>
            <div className="heatmapScroll">
              <table className="heatmap">
                <thead>
                  <tr>
                    <th>{heatmapRowLabel}</th>
                    <th>Ad spend</th>
                    <th>Installs</th>
                    <th>CPI</th>
                    {availableCohorts.map((cohort) => (
                      <th key={cohort}>{formatCohort(cohort)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderedPeriods.map((period) => (
                    (() => {
                      const rowValues = availableCohorts
                        .map((cohort) => (enablePrediction ? predictedRoas.get(`${period}|||${cohort}`) : periodRoas.get(`${period}|||${cohort}`)) ?? null)
                        .filter((value): value is number => value !== null);
                      const rowMax = rowValues.length > 0 ? Math.max(...rowValues) : maxRoas;
                      return (
                        <tr key={period}>
                          <th>{period}</th>
                          <td>{(periodCost.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                          <td>{(periodInstalls.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                          <td>{(periodCpi.get(period) ?? null) === null ? 'N/A' : (periodCpi.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                          {availableCohorts.map((cohort) => {
                            const cellKey = `${period}|||${cohort}`;
                            const value = enablePrediction ? predictedRoas.get(cellKey) ?? null : periodRoas.get(cellKey) ?? null;
                            const isPredicted = enablePrediction ? predictedMask.get(cellKey) ?? false : false;
                            return (
                              <td
                                key={`${period}-${cohort}`}
                                className={isPredicted ? 'predictedCell' : undefined}
                                style={heatmapStyle(value, rowMax, isDarkMode)}
                                title={isPredicted ? 'Predicted value' : 'Actual value'}
                              >
                                {value === null ? '∞ / N/A' : `${isPredicted ? '★ ' : ''}${(value * 100).toFixed(1)}%${isPredicted ? '*' : ''}`}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })()
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div className="ratioHeader">
              <p className="tableTitle">
                {secondaryTableMode === 'ltv'
                  ? 'LTV Evolution (Revenue / Installs)'
                  : secondaryTableMode === 'ratios'
                    ? 'Ratio Evolution Table'
                    : 'Usuarios retenidos por cohort'}
              </p>
              <span className="tableContext">
                {secondaryTableMode === 'ltv'
                  ? 'Muestra cuánto revenue aporta cada install por ventana.'
                  : secondaryTableMode === 'ratios'
                    ? 'Compara el crecimiento entre ventanas o su peso en el lifetime.'
                    : 'Resume usuarios retenidos por ventana y revenue restante para break-even.'}
              </span>
              <select value={secondaryTableMode} onChange={(event) => setSecondaryTableMode(event.target.value as 'ltv' | 'ratios' | 'retained')}>
                <option value="ltv">LTV</option>
                <option value="ratios">RATIOS</option>
                <option value="retained">USUARIOS RETENIDOS</option>
              </select>
            </div>
            {secondaryTableMode === 'ltv' ? (
              <div className="heatmapScroll">
                <table className="heatmap">
                  <thead>
                    <tr>
                      <th>{heatmapRowLabel}</th>
                      <th>Ad spend</th>
                      <th>Installs</th>
                      <th>CPI</th>
                      {availableCohorts.map((cohort) => (
                        <th key={`ltv-${cohort}`}>{`LTV ${normalizeCohortLabel(cohort)}`}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orderedPeriods.map((period) => (
                      (() => {
                        const rowValues = availableCohorts
                          .map((cohort) => (enablePrediction ? predictedLtv.get(`${period}|||${cohort}`) : periodLtv.get(`${period}|||${cohort}`)) ?? null)
                          .filter((value): value is number => value !== null);
                        const rowMax = rowValues.length > 0 ? Math.max(...rowValues) : 1;
                        return (
                          <tr key={`ltv-${period}`}>
                            <th>{period}</th>
                            <td>{(periodCost.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                            <td>{(periodInstalls.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                            <td>{(periodCpi.get(period) ?? null) === null ? 'N/A' : (periodCpi.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                            {availableCohorts.map((cohort) => {
                              const key = `${period}|||${cohort}`;
                              const value = enablePrediction ? predictedLtv.get(key) ?? null : periodLtv.get(key) ?? null;
                              const isPredicted = enablePrediction ? predictedMask.get(key) ?? false : false;
                              return (
                                <td key={`ltv-${period}-${cohort}`} className={isPredicted ? 'predictedCell' : undefined} style={heatmapStyle(value, rowMax, isDarkMode)}>
                                  {value === null ? '∞ / N/A' : `${isPredicted ? '★ ' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${isPredicted ? '*' : ''}`}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })()
                    ))}
                  </tbody>
                </table>
              </div>
            ) : secondaryTableMode === 'ratios' ? (
              <>
                <div className="ratioModeTabs">
                  <button
                    type="button"
                    className={`ratioModeBtn ${ratioTableMode === 'growth' ? 'active' : ''}`}
                    onClick={() => setRatioTableMode('growth')}
                  >
                    Growth ratio
                  </button>
                  <button
                    type="button"
                    className={`ratioModeBtn ${ratioTableMode === 'distribution' ? 'active' : ''}`}
                    onClick={() => setRatioTableMode('distribution')}
                  >
                    Distribution ratio
                  </button>
                </div>
                <label className="toggleRow">
                  <input
                    type="checkbox"
                    checked={ratioTableHeatmapEnabled}
                    onChange={(event) => setRatioTableHeatmapEnabled(event.target.checked)}
                  />
                  <span>Heatmap? {ratioTableHeatmapEnabled ? 'Yes' : 'No'}</span>
                </label>
                <div className="heatmapScroll">
                  <table className="heatmap">
                    <thead>
                      <tr>
                        <th>Cohort date</th>
                        {availableCohorts.slice(0, -1).map((from, index) => {
                          const to = availableCohorts[index + 1];
                          return <th key={`ratio-secondary-${from}-${to}`}>{`${normalizeCohortLabel(from)}→${normalizeCohortLabel(to)}`}</th>;
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {(ratioTableMode === 'growth' ? ratioEvolutionRows : periodDistributionRatios).map((row) => {
                        const rowValues = cohortPairs
                          .map(([from, to]) => row.ratios[ratioKey(from, to)] ?? null)
                          .filter((value): value is number => value !== null);
                        const rowMax = rowValues.length > 0 ? Math.max(...rowValues) : 1;
                        return (
                          <tr key={`ratio-secondary-row-${row.period}`}>
                            <th>{row.period}</th>
                            {cohortPairs.map(([from, to]) => {
                              const key = ratioKey(from, to);
                              const value = row.ratios[key] ?? null;
                              const isPredicted =
                                ratioTableMode === 'growth' && 'predicted' in row ? row.predicted[key] ?? false : false;
                              return (
                                <td
                                  key={`ratio-secondary-val-${row.period}-${from}`}
                                  style={ratioTableHeatmapEnabled ? heatmapStyle(value, rowMax, isDarkMode) : undefined}
                                >
                                  {value === null ? '—' : ratioTableMode === 'growth'
                                    ? `${isPredicted ? '★ ' : ''}${value.toFixed(3)}x`
                                    : `${(value * 100).toFixed(1)}%`}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="heatmapScroll">
                <table className="heatmap">
                  <thead>
                    <tr>
                      <th>{heatmapRowLabel}</th>
                      <th>Installs</th>
                      {availableRetentionCohorts.map((cohort) => (
                        <th key={`retained-${cohort}`}>{`Retenidos ${normalizeCohortLabel(cohort)}`}</th>
                      ))}
                      <th>Revenue left</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderedPeriods.map((period) => (
                      <tr key={`retained-row-${period}`}>
                        <th>{period}</th>
                        <td>{(periodInstalls.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                        {availableRetentionCohorts.map((cohort) => {
                          const key = `${period}|||${cohort}`;
                          const value = retainedUsersData.periodRetainedUsers.get(key) ?? null;
                          const isFallback = enablePrediction ? retainedUsersData.periodRetentionPredictedMask.get(key) ?? false : false;
                          return (
                            <td key={`retained-${period}-${cohort}`} className={isFallback ? 'predictedCell' : undefined}>
                              {value === null ? 'N/A' : `${isFallback ? '★ ' : ''}${Math.round(value).toLocaleString('en-US')}`}
                            </td>
                          );
                        })}
                        <td>{(retainedUsersData.periodRevenueLeft.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {enablePrediction && (
          <>
            <p className="legend">
              Predicción activa en el mismo ROAS Heatmap: se completan faltantes en la tabla principal con * y borde
              punteado.
            </p>

            <div className="predictionExplain">
              <h3>¿Cómo se calcula la predicción?</h3>
              <ol>
                <li>
                  Tomamos el comportamiento histórico por “etapa” del cohort: <b>temprano</b> (D0→D30), <b>medio</b> (D30→D90) y <b>tardío</b> (D90+).
                  <div className="simpleHint">Ejemplo simple: para predecir D30, miramos cómo suelen crecer D14→D30 en datos parecidos.</div>
                </li>
                <li>
                  Calculamos un promedio robusto para no dejarnos llevar por valores extremos.
                  <div className="simpleHint">Ejemplo: si casi todos crecen ~1.05x y uno solo 1.80x, ese 1.80x no domina la predicción.</div>
                </li>
                <li>
                  Pedimos un mínimo de muestras para confiar en una señal: <b>6</b> en etapas temprana/media y <b>3</b> en tardía.
                  <div className="simpleHint">Es decir: temprana/media cubre de D0 a D90 (donde pedimos más evidencia), y tardía es de D90 en adelante (acepta menos casos porque hay menos cohorts maduras). Esto evita tomar decisiones con datos débiles.</div>
                </li>
                <li>
                  Si un salto sale muy raro, lo limitamos a un rango razonable para mantener estabilidad.
                  <div className="simpleHint">Esto evita picos o caídas irreales cuando hay datos escasos o muy volátiles.</div>
                </li>
                <li>
                  Usamos <b>fallbacks</b>: primero intentamos campaña, luego red, luego país (si está activo), y finalmente global.
                  <div className="simpleHint">En pocas palabras: arrancamos por lo más específico y, si no alcanza, vamos a una vista más amplia.</div>
                </li>
                <li>
                  Cuando falta un ROAS, lo construimos paso a paso desde el último valor real disponible.
                  <div className="simpleHint">Ejemplo: <code>ROAS D30 = ROAS D14 × ratio(D14→D30)</code>.</div>
                </li>
              </ol>

              <p className="ratioTitle">Ratios vigentes + fallback usado (según filtros actuales):</p>
              <ul>
                {(['android', 'ios', 'other'] as const).map((osKey) => {
                  const pairs = Object.entries(ratioSummary[osKey]);
                  return (
                    <li key={`ratio-${osKey}`}>
                      <b>{osKey.toUpperCase()}:</b>{' '}
                      {pairs.length === 0
                        ? 'sin ratios suficientes'
                        : pairs
                            .map(([pair, ratio]) => {
                              const [from, to] = pair.split('=>');
                              const fallback = activeFallbackLabels[osKey][pair] ?? 'global';
                              return `${normalizeCohortLabel(from)}→${normalizeCohortLabel(to)} = ${ratio.toFixed(3)}x (${fallback})`;
                            })
                            .join(' | ')}
                    </li>
                  );
                })}
              </ul>
              {maturedOnly && maturityDiagnostics.length > 0 && (
                <>
                  <p className="ratioTitle">Validación de madurez (evita “saltos” engañosos por ventana parcial):</p>
                  <ul>
                    {maturityDiagnostics.map((item) => (
                      <li key={`diag-${item.period}-${item.cohort}`}>
                        {item.period} / {normalizeCohortLabel(item.cohort)} tenía cobertura madura parcial ({(item.matureCoverage * 100).toFixed(1)}%), por eso ahora se muestra como N/A hasta completar ventana.
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </>
        )}

        {secondaryTableMode === 'retained' && (
          <div className="predictionExplain">
            <h3>¿Cómo calculamos “usuarios retenidos” y “revenue left”?</h3>
            <ol>
              <li>
                Para cada cohort (D1, D3, D14, etc.) tomamos la retención real promedio ponderada por installs.
                <div className="simpleHint">Más installs = más peso, así evitamos que un cohort chico distorsione el resultado.</div>
              </li>
              <li>
                Convertimos la retención en usuarios netos: <code>Retenidos netos = installs del período × retención</code>.
                <div className="simpleHint">Ejemplo: 10,000 installs con retención D3 de 0.12 ⇒ 1,200 usuarios retenidos D3.</div>
              </li>
              <li>
                Si falta data y activás <b>Enable prediction</b>, usamos fallback por capas:
                histórico de campañas en la misma network → orgánico por país → OS → país → global.
                <div className="simpleHint">Siempre usamos retención real observada; no es una predicción “caja negra”.</div>
              </li>
              <li>
                Aplicamos una regla de consistencia temporal: un día más tardío no puede tener más retenidos que el día anterior.
                <div className="simpleHint">Ejemplo: si D90 sale mayor que D60 por fallback, se ajusta para que D90 ≤ D60.</div>
              </li>
              <li>
                Por ahora solo imputamos faltantes hasta <b>D120</b>. En D180/D360 no rellenamos si no hay dato real.
                <div className="simpleHint">Esto evita sobreextender la señal cuando la evidencia tardía es muy débil.</div>
              </li>
              <li>
                <b>Revenue left</b> es cuánto falta recuperar para break-even: <code>max(0, cost - revenue recuperado)</code>.
                <div className="simpleHint">Si ya superó costo, revenue left queda en 0.</div>
              </li>
            </ol>
          </div>
        )}
          </>
        )}

        {mainViewTab === 'graficos' && (
        <div className={`ratioChartCard ${mainViewTab === 'graficos' ? 'chartTabCard' : ''}`}>
          <div className="ratioHeader">
            <h3>Evolución de ROAS por Cohort</h3>
            <select value={bottomChartMode} onChange={(event) => setBottomChartMode(event.target.value as 'roas' | 'ratios')}>
              <option value="roas">ROAS</option>
              <option value="ratios">RATIOS</option>
            </select>
          </div>
          <p className="legend">
            {bottomChartMode === 'roas'
              ? 'Cada línea es un cohort date. Eje X = ventanas (D0..D360). Eje Y = ROAS.'
              : 'Cada línea es un salto de ratio. Eje X = cohort date. Eje Y = ratio (x).'}
          </p>
          <div className="ratioToggleWrap">
            {bottomChartSeries.map((series) => {
              const active = selectedRatioKeys.includes(series.key);
              return (
                <button
                  key={`btn-${series.key}`}
                  type="button"
                  className={`ratioBtn ${active ? 'active' : ''}`}
                  onClick={() =>
                    setSelectedRatioKeys((current) =>
                      current.includes(series.key) ? current.filter((key) => key !== series.key) : [...current, series.key]
                    )
                  }
                >
                  <span className="dot" style={{ backgroundColor: series.color }} />
                  {series.label}
                </button>
              );
            })}
          </div>

          <div className="ratioChartWrap">
            <svg
              className="ratioChart"
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="ROAS evolution chart"
              onMouseMove={handleRatioMouseMove}
              onMouseLeave={() => setHoveredRatioIndex(null)}
            >
              <defs>
                {activeSeries.map((series, index) => (
                  <linearGradient key={`grad-${series.key}`} id={`series-grad-${index}`} x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor={series.color} />
                    <stop offset="100%" stopColor={series.accent} />
                  </linearGradient>
                ))}
              </defs>
              {ratioYTicks.map(({ y }, tick) => (
                <line key={`grid-${tick}`} x1={chartPadding.left} x2={chartWidth - chartPadding.right} y1={y} y2={y} className="gridLine" />
              ))}
              <line x1={chartPadding.left} y1={chartPadding.top} x2={chartPadding.left} y2={chartPadding.top + plotHeight} className="axisLine" />
              <line x1={chartPadding.left} y1={chartPadding.top + plotHeight} x2={chartWidth - chartPadding.right} y2={chartPadding.top + plotHeight} className="axisLine" />
              <text x={14} y={chartPadding.top + 6} className="axisLabel">{bottomChartMode === 'roas' ? 'ROAS' : 'Ratio'}</text>
              {ratioYTicks.map(({ y, value }) => (
                <text key={`ytick-${y}`} x={chartPadding.left - 8} y={y + 4} textAnchor="end" className="axisLabel">
                  {bottomChartMode === 'roas' ? `${(value * 100).toFixed(0)}%` : `${value.toFixed(2)}x`}
                </text>
              ))}

              {bottomChartMode === 'roas' ? (
                roasVisibleCohorts.map((cohort, index) => {
                  const x = chartPadding.left + (plotWidth * index) / Math.max(roasVisibleCohorts.length - 1, 1);
                  return (
                    <text key={`xtick-${cohort}`} x={x} y={chartHeight - 18} textAnchor="middle" className="axisLabel">
                      {normalizeCohortLabel(cohort)}
                    </text>
                  );
                })
              ) : (
                ratioEvolutionRows.length > 0 && (
                  <>
                    <text x={chartPadding.left} y={chartHeight - 18} className="axisLabel">{ratioEvolutionRows[0]?.period}</text>
                    <text x={chartPadding.left + plotWidth / 2 - 40} y={chartHeight - 18} className="axisLabel">
                      {ratioEvolutionRows[Math.floor((ratioEvolutionRows.length - 1) / 2)]?.period}
                    </text>
                    <text x={chartWidth - chartPadding.right - 90} y={chartHeight - 18} className="axisLabel">
                      {ratioEvolutionRows[ratioEvolutionRows.length - 1]?.period}
                    </text>
                  </>
                )
              )}

              {activeSeries.map((series, seriesIndex) => {
                type RoasPoint = { x: number; y: number; value: number; cohort: string; predicted: boolean };
                const chartValues =
                  bottomChartMode === 'roas'
                    ? roasVisibleCohorts.map((cohort) => {
                        const originalIndex = availableCohorts.indexOf(cohort);
                        return {
                          value: originalIndex >= 0 ? series.values[originalIndex] : null,
                          predicted: originalIndex >= 0 ? series.predicted[originalIndex] ?? false : false,
                          cohort
                        };
                      })
                    : series.values.map((value, index) => ({
                        value,
                        predicted: series.predicted[index] ?? false,
                        cohort: ratioEvolutionRows[index]?.period ?? ''
                      }));
                const points = chartValues
                  .map((value, index) => {
                    if (value.value === null) return null;
                    const x = chartPadding.left + (plotWidth * index) / Math.max(chartPointCount - 1, 1);
                    const y = chartPadding.top + plotHeight - (value.value / maxRatioValue) * plotHeight;
                    return { x, y, value: value.value, cohort: value.cohort, predicted: value.predicted };
                  })
                  .filter((point): point is RoasPoint => point !== null);
                const d = buildLinePath(points.map((point) => ({ x: point.x, y: point.y })));
                return (
                  <g key={`line-${series.key}`}>
                    <path d={d} stroke={`url(#series-grad-${seriesIndex})`} className="ratioLine roasAnimatedLine" />
                    {points.map((point) => (
                      <circle
                        key={`${series.key}-${point.x}`}
                        cx={point.x}
                        cy={point.y}
                        r={point.predicted ? 3.2 : 4}
                        fill={point.predicted ? 'transparent' : series.color}
                        stroke={series.color}
                        className={point.predicted ? 'ratioPredictedPoint' : 'ratioPoint'}
                      >
                        <title>{`${series.label} | ${bottomChartMode === 'roas' ? normalizeCohortLabel(point.cohort) : point.cohort} | ${bottomChartMode === 'roas' ? `${(point.value * 100).toFixed(1)}%` : `${point.value.toFixed(3)}x`}${point.predicted ? ' (pred)' : ''}`}</title>
                      </circle>
                    ))}
                  </g>
                );
              })}
            </svg>

            {hoveredRatioX !== null && (
              <div
                className="ratioHoverGuide"
                style={{ left: `${(hoveredRatioX / chartWidth) * 100}%` }}
              />
            )}

            {hoveredRatioDetails && hoveredRatioX !== null && (
              <div
                className="ratioHoverPanel"
                style={{ left: `${Math.min(Math.max((hoveredRatioX / chartWidth) * 100 + 2, 2), 66)}%` }}
              >
                <b>{hoveredRatioDetails.xLabel}</b>
                <ul>
                  {hoveredRatioDetails.details.length > 0 ? (
                    hoveredRatioDetails.details.map((entry) => (
                      <li key={`hover-${entry.label}`}>
                        <span className="hoverLabel" style={{ color: entry.color }}>{entry.label}</span> = {bottomChartMode === 'roas' ? `${(entry.value * 100).toFixed(1)}%` : `${entry.value.toFixed(3)}x`}{entry.predicted ? ' (pred)' : ''}
                      </li>
                    ))
                  ) : (
                    <li>Sin datos en este punto.</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        </div>
        )}
      </section>
    </main>
  );
}

