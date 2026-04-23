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
  const raw = cohortKey.replace('all_revenue_total_', '').toUpperCase();
  if (raw === 'M6') return 'D180';
  if (raw === 'M12') return 'D360';
  return raw;
}

function cohortSortValue(cohortKey: string): number {
  const raw = cohortKey.replace('all_revenue_total_', '').toLowerCase();
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
  const raw = cohortKey.replace('all_revenue_total_', '').toLowerCase();
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
  const [granularity, setGranularity] = useState<Granularity>('daily');
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
  const [ratioView, setRatioView] = useState<'table' | 'chart'>('table');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataSourceLabel, setDataSourceLabel] = useState('Campaign data.csv');
  const [selectedRatioKeys, setSelectedRatioKeys] = useState<string[]>([]);
  const [hoveredRatioIndex, setHoveredRatioIndex] = useState<number | null>(null);
  const [heatmapOrderBy, setHeatmapOrderBy] = useState<HeatmapOrderBy>('cohort_date');
  const [quickDatePreset, setQuickDatePreset] = useState<QuickDatePreset>('all_time');

  useEffect(() => {
    document.body.dataset.theme = isDarkMode ? 'dark' : 'light';
  }, [isDarkMode]);

  const applyParsedCsv = (result: Papa.ParseResult<CsvRow>, label: string) => {
    const fields = result.meta.fields ?? [];
    const cohorts = fields
      .filter((field) => field.startsWith('all_revenue_total_'))
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
          revenueByCohort
        } satisfies DataRow;
      })
      .filter((row): row is DataRow => row !== null)
      .sort((a, b) => a.day.getTime() - b.day.getTime());

    setRows(parsed);
    setAvailableCohorts(cohorts);
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

  const { orderedPeriods, periodCost, periodInstalls, periodCpi, periodRoas, periodLtv, predictedRoas, predictedMask, ratioSummary, periodJumpRatios, maxRoas, maturityDiagnostics } = useMemo(() => {
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
      maxDay: Date
    ) => {
      for (const row of sourceRows) {
        cohortPairs.forEach(([fromCohort, toCohort]) => {
          const toDays = cohortWindowDays(toCohort);
          const toIsMatured = row.day.getTime() + toDays * 86400000 <= maxDay.getTime();
          const fromValue = row.revenueByCohort[fromCohort] ?? 0;
          const toValue = row.revenueByCohort[toCohort] ?? 0;
          if (toIsMatured && fromValue > 0 && toValue > 0 && toValue >= fromValue) {
            const key = ratioKey(fromCohort, toCohort);
            const entry = accumulator[row.os][key] ?? [];
            entry.push({ ratio: toValue / fromValue, weight: Math.max(row.cost, 1) });
            accumulator[row.os][key] = entry;
          }
        });
      }
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

    accumulateRatios(campaignRows, campaignRatioAccumulator, maxAvailableDayGlobal);
    accumulateRatios(networkRows, networkRatioAccumulator, maxAvailableDayGlobal);
    accumulateRatios(countryRows, osRatioAccumulator, maxAvailableDayGlobal);
    for (const row of countryRows) {
      const bucket = countryRatioAccumulator[row.os][row.country] ?? {};
      countryRatioAccumulator[row.os][row.country] = bucket;
      cohortPairs.forEach(([fromCohort, toCohort]) => {
        const toDays = cohortWindowDays(toCohort);
        const toIsMatured = row.day.getTime() + toDays * 86400000 <= maxAvailableDayGlobal.getTime();
        const fromValue = row.revenueByCohort[fromCohort] ?? 0;
        const toValue = row.revenueByCohort[toCohort] ?? 0;
        if (toIsMatured && fromValue > 0 && toValue > 0 && toValue >= fromValue) {
          const key = ratioKey(fromCohort, toCohort);
          const entry = bucket[key] ?? [];
          entry.push({ ratio: toValue / fromValue, weight: Math.max(row.cost, 1) });
          bucket[key] = entry;
        }
      });
    }
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

    const buildWeightedMedianAverages = (
      accumulator: Record<string, Record<string, Array<{ ratio: number; weight: number }>>>
    ): Record<string, Record<string, number>> => {
      const output: Record<string, Record<string, number>> = {
        android: {},
        ios: {},
        other: {}
      };
      (['android', 'ios', 'other'] as const).forEach((osKey) => {
        Object.entries(accumulator[osKey]).forEach(([key, samples]) => {
          if (samples.length >= 6) {
            const sorted = [...samples].sort((a, b) => a.ratio - b.ratio);
            const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
            const halfWeight = totalWeight / 2;
            let running = 0;
            let weightedMedian = sorted[sorted.length - 1].ratio;
            for (const sample of sorted) {
              running += sample.weight;
              if (running >= halfWeight) {
                weightedMedian = sample.ratio;
                break;
              }
            }
            output[osKey][key] = weightedMedian;
          }
        });
      });
      return output;
    };

    const campaignRatioAverages = buildWeightedMedianAverages(campaignRatioAccumulator);
    const networkRatioAverages = buildWeightedMedianAverages(networkRatioAccumulator);
    const osRatioAveragesGlobal = buildWeightedMedianAverages(osRatioAccumulator);
    const countryRatioAverages: Record<string, Record<string, Record<string, number>>> = {
      android: {},
      ios: {},
      other: {}
    };
    const buildCountryMedian = (
      data: Record<string, Array<{ ratio: number; weight: number }>>
    ): Record<string, number> => {
      const output: Record<string, number> = {};
      Object.entries(data).forEach(([key, samples]) => {
        if (samples.length >= 6) {
          const sorted = [...samples].sort((a, b) => a.ratio - b.ratio);
          const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
          const halfWeight = totalWeight / 2;
          let running = 0;
          let weightedMedian = sorted[sorted.length - 1].ratio;
          for (const sample of sorted) {
            running += sample.weight;
            if (running >= halfWeight) {
              weightedMedian = sample.ratio;
              break;
            }
          }
          output[key] = weightedMedian;
        }
      });
      return output;
    };
    (['android', 'ios', 'other'] as const).forEach((osKey) => {
      Object.entries(countryRatioAccumulator[osKey]).forEach(([country, data]) => {
        countryRatioAverages[osKey][country] = buildCountryMedian(data);
      });
    });

    const activeRatioSummary: Record<string, Record<string, number>> = {
      android: {},
      ios: {},
      other: {}
    };
    const periodJumpRatiosMap = new Map<string, Record<string, number>>();

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
        (['android', 'ios', 'other'] as const).forEach((osKey) => {
          const weight = (values.osCost[osKey] ?? 0) / osTotal;
          const countryCostMap = values.osCountryCost[osKey] ?? {};
          const topCountry =
            Object.entries(countryCostMap).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';
          const ratio =
            campaignRatioAverages[osKey][key] ??
            networkRatioAverages[osKey][key] ??
            (enableCountryFallback ? countryRatioAverages[osKey][topCountry]?.[key] : undefined) ??
            osRatioAveragesGlobal[osKey][key];
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
      maxRoas: currentMax,
      maturityDiagnostics: maturityDiagnosticsRows.slice(0, 8)
    };
  }, [rows, heatmapRows, heatmapOrderBy, granularity, availableCohorts, maturedOnly, selectedCampaigns, selectedNetworks, selectedCountries, enableCountryFallback]);

  const ratioEvolutionRows = useMemo(() => {
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

    const pairs = availableCohorts
      .slice(0, -1)
      .map((cohort, index) => [cohort, availableCohorts[index + 1]] as const);

    return Array.from(periodRevenue.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, revenues]) => {
        const ratios: Record<string, number | null> = {};
        const predicted: Record<string, boolean> = {};
        const fallbackRatios = periodJumpRatios.get(period) ?? {};
        for (const [from, to] of pairs) {
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
  }, [heatmapRows, availableCohorts, granularity, maturedOnly, enablePrediction, periodJumpRatios]);

  const ratioPairs = useMemo(
    () => availableCohorts.slice(0, -1).map((from, index) => [from, availableCohorts[index + 1]] as const),
    [availableCohorts]
  );

  useEffect(() => {
    setSelectedRatioKeys(ratioPairs.map(([from, to]) => ratioKey(from, to)));
  }, [ratioPairs]);

  const ratioChartSeries = useMemo(() => {
    const palette = ['#38bdf8', '#6ee7b7', '#a78bfa', '#fca5a5', '#fcd34d', '#60a5fa', '#e879f9', '#22d3ee'];
    return ratioPairs.map(([from, to], index) => {
      const key = ratioKey(from, to);
      return {
        key,
        label: `${normalizeCohortLabel(from)}→${normalizeCohortLabel(to)}`,
        color: palette[index % palette.length],
        values: ratioEvolutionRows.map((row) => row.ratios[key] ?? null),
        predicted: ratioEvolutionRows.map((row) => row.predicted[key] ?? false)
      };
    });
  }, [ratioPairs, ratioEvolutionRows]);

  const chartWidth = 980;
  const chartHeight = 300;
  const chartPadding = { top: 20, right: 16, bottom: 30, left: 44 };
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right;
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const activeSeries = ratioChartSeries.filter((series) => selectedRatioKeys.includes(series.key));
  const maxRatioValue = Math.max(
    1.2,
    ...activeSeries.flatMap((series) => series.values.filter((value): value is number => value !== null))
  );
  const ratioYTicks = [0, 1, 2, 3, 4].map((tick) => ({
    y: chartPadding.top + (plotHeight * tick) / 4,
    value: maxRatioValue * (1 - tick / 4)
  }));
  const hoveredRatioDetails = useMemo(() => {
    if (hoveredRatioIndex === null) return null;
    const row = ratioEvolutionRows[hoveredRatioIndex];
    if (!row) return null;
    return {
      period: row.period,
      details: activeSeries
        .map((series) => ({ label: series.label, color: series.color, value: series.values[hoveredRatioIndex], predicted: series.predicted[hoveredRatioIndex] ?? false }))
        .filter((entry): entry is { label: string; color: string; value: number; predicted: boolean } => entry.value !== null)
    };
  }, [hoveredRatioIndex, ratioEvolutionRows, activeSeries]);
  const hoveredRatioX = useMemo(() => {
    if (hoveredRatioIndex === null || ratioEvolutionRows.length === 0) return null;
    return chartPadding.left + (plotWidth * hoveredRatioIndex) / Math.max(ratioEvolutionRows.length - 1, 1);
  }, [hoveredRatioIndex, ratioEvolutionRows.length, chartPadding.left, plotWidth]);
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

  function handleRatioMouseMove(event: ReactMouseEvent<SVGSVGElement>): void {
    if (ratioEvolutionRows.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const relativeX = (pointerX / bounds.width) * chartWidth;
    const clampedX = Math.min(Math.max(relativeX, chartPadding.left), chartWidth - chartPadding.right);
    const ratio = (clampedX - chartPadding.left) / Math.max(plotWidth, 1);
    const nextIndex = Math.round(ratio * Math.max(ratioEvolutionRows.length - 1, 0));
    setHoveredRatioIndex(nextIndex);
  }

  return (
    <main className="layout">
      <aside className="filters">
        <div className="titleRow">
          <h1>ROAS Heatmap</h1>
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
        <p className="legend">
          Tabla heatmap: primera columna según Order by, luego Ad spend, Installs, CPI y ROAS en porcentaje por
          cohort (D0, D3, D7, etc). Con &quot;Maturated cohorts only?&quot; activo, solo se muestran ventanas
          completas.
        </p>
        <div className="dualHeatmapGrid">
          <div>
            <p className="legend">ROAS Heatmap</p>
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
                        .map((cohort) => periodRoas.get(`${period}|||${cohort}`) ?? null)
                        .filter((value): value is number => value !== null);
                      const rowMax = rowValues.length > 0 ? Math.max(...rowValues) : maxRoas;
                      return (
                        <tr key={period}>
                          <th>{period}</th>
                          <td>{(periodCost.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                          <td>{(periodInstalls.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                          <td>{(periodCpi.get(period) ?? null) === null ? 'N/A' : (periodCpi.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                          {availableCohorts.map((cohort) => {
                            const value = periodRoas.get(`${period}|||${cohort}`) ?? null;
                            return (
                              <td key={`${period}-${cohort}`} style={heatmapStyle(value, rowMax, isDarkMode)}>
                                {value === null ? '∞ / N/A' : `${(value * 100).toFixed(1)}%`}
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
            <p className="legend">LTV Evolution (Revenue / Installs)</p>
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
                        .map((cohort) => periodLtv.get(`${period}|||${cohort}`) ?? null)
                        .filter((value): value is number => value !== null);
                      const rowMax = rowValues.length > 0 ? Math.max(...rowValues) : 1;
                      return (
                        <tr key={`ltv-${period}`}>
                          <th>{period}</th>
                          <td>{(periodCost.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                          <td>{(periodInstalls.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                          <td>{(periodCpi.get(period) ?? null) === null ? 'N/A' : (periodCpi.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                          {availableCohorts.map((cohort) => {
                            const value = periodLtv.get(`${period}|||${cohort}`) ?? null;
                            return (
                              <td key={`ltv-${period}-${cohort}`} style={heatmapStyle(value, rowMax, isDarkMode)}>
                                {value === null ? '∞ / N/A' : value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
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
        </div>

        {enablePrediction && (
          <>
            <p className="legend">
              Heatmap con predicción: usa valores reales cuando existen y completa faltantes de forma secuencial por
              ratios de progresión (segmentado por OS). Las predicciones tienen * y borde punteado.
            </p>
            <div className="heatmapScroll">
              <table className="heatmap">
                <thead>
                  <tr>
                    <th>{heatmapRowLabel}</th>
                    <th>Ad spend</th>
                    <th>Installs</th>
                    <th>CPI</th>
                    {availableCohorts.map((cohort) => (
                      <th key={`pred-${cohort}`}>{formatCohort(cohort)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderedPeriods.map((period) => (
                    (() => {
                      const rowValues = availableCohorts
                        .map((cohort) => predictedRoas.get(`${period}|||${cohort}`) ?? null)
                        .filter((value): value is number => value !== null);
                      const rowMax = rowValues.length > 0 ? Math.max(...rowValues) : maxRoas;
                      return (
                        <tr key={`pred-${period}`}>
                          <th>{period}</th>
                          <td>{(periodCost.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                          <td>{(periodInstalls.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                          <td>{(periodCpi.get(period) ?? null) === null ? 'N/A' : (periodCpi.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                          {availableCohorts.map((cohort) => {
                            const cellKey = `${period}|||${cohort}`;
                            const value = predictedRoas.get(cellKey) ?? null;
                            const isPredicted = predictedMask.get(cellKey) ?? false;
                            return (
                              <td
                                key={`pred-${period}-${cohort}`}
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

            <div className="predictionExplain">
              <h3>¿Cómo se calcula la predicción?</h3>
              <ol>
                <li>
                  Para cada salto entre cohorts (ej: D7→D14), calculamos ratios históricos con datos <b>completos</b>
                  usando <b>todo el histórico disponible (all-time)</b>, no solo la ventana visible.
                </li>
                <li>
                  Usamos <b>mediana ponderada por spend</b> y muestra mínima (&gt;=6) para evitar outliers y saltos
                  inestables.
                </li>
                <li>
                  Fallback jerárquico por OS con histórico all-time:
                  <b>campaña → network → (país si está activado) → OS global</b>. Si un salto tardío no tiene data
                  suficiente en campaña (ej: Unity), sube al siguiente nivel automáticamente.
                </li>
                <li>
                  Si un ratio real es &lt; 1.00 o no existe, se considera no confiable para la tabla de ratios y se deja
                  como N/A; con predicción activa se completa con el ratio estimado del fallback.
                </li>
                <li>
                  Cuando falta un ROAS, proyectamos secuencialmente desde el último punto disponible:
                  <code>ROAS D30 = ROAS D14 × ratio(D14→D30)</code>.
                </li>
                <li>
                  Si faltan pasos intermedios, encadenamos múltiples ratios:
                  <code>ROAS D120 = D30 × r(D30→D60) × r(D60→D90) × r(D90→D120)</code>.
                </li>
              </ol>

              <p className="ratioTitle">Ratios vigentes en esta vista (calculados con histórico all-time + fallback):</p>
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
                              return `${normalizeCohortLabel(from)}=>${normalizeCohortLabel(to)}=${ratio.toFixed(3)}`;
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

        <div className="ratioChartCard">
          <div className="ratioHeader">
            <h3>Ratio Evolution By Date</h3>
            <button type="button" className="modeBtn" onClick={() => setRatioView((v) => (v === 'table' ? 'chart' : 'table'))}>
              {ratioView === 'table' ? 'Ver como gráfico' : 'Ver como tabla'}
            </button>
          </div>
          <p className="legend">Cada línea es un jump ratio. Eje X = cohort date. Eje Y = ratio.</p>
          <div className="ratioToggleWrap">
            {ratioChartSeries.map((series) => {
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

          {ratioView === 'chart' ? (
            <div className="ratioChartWrap">
              <svg
                className="ratioChart"
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                role="img"
                aria-label="Ratio chart"
                onMouseMove={handleRatioMouseMove}
                onMouseLeave={() => setHoveredRatioIndex(null)}
              >
                {ratioYTicks.map(({ y }, tick) => (
                  <line key={`grid-${tick}`} x1={chartPadding.left} x2={chartWidth - chartPadding.right} y1={y} y2={y} className="gridLine" />
                ))}
                <line x1={chartPadding.left} y1={chartPadding.top} x2={chartPadding.left} y2={chartPadding.top + plotHeight} className="axisLine" />
                <line x1={chartPadding.left} y1={chartPadding.top + plotHeight} x2={chartWidth - chartPadding.right} y2={chartPadding.top + plotHeight} className="axisLine" />
                <text x={14} y={chartPadding.top + 6} className="axisLabel">Ratio</text>
                {ratioYTicks.map(({ y, value }) => (
                  <text key={`ytick-${y}`} x={chartPadding.left - 8} y={y + 4} textAnchor="end" className="axisLabel">
                    {value.toFixed(2)}x
                  </text>
                ))}

                {ratioEvolutionRows.length > 0 && (
                  <>
                    <text x={chartPadding.left} y={chartHeight - 8} className="axisLabel">{ratioEvolutionRows[0].period}</text>
                    <text x={chartPadding.left + plotWidth / 2 - 36} y={chartHeight - 8} className="axisLabel">
                      {ratioEvolutionRows[Math.floor((ratioEvolutionRows.length - 1) / 2)]?.period}
                    </text>
                    <text x={chartWidth - chartPadding.right - 84} y={chartHeight - 8} className="axisLabel">
                      {ratioEvolutionRows[ratioEvolutionRows.length - 1]?.period}
                    </text>
                  </>
                )}

                {activeSeries.map((series) => {
                  type RatioPoint = { x: number; y: number; value: number; period: string; predicted: boolean };
                  const points = series.values
                    .map((value, index) => {
                      if (value === null) return null;
                      const x = chartPadding.left + (plotWidth * index) / Math.max(ratioEvolutionRows.length - 1, 1);
                      const y = chartPadding.top + plotHeight - (value / maxRatioValue) * plotHeight;
                      return { x, y, value, period: ratioEvolutionRows[index].period, predicted: series.predicted[index] ?? false };
                    })
                    .filter((point): point is RatioPoint => point !== null);
                  const realPoints = points.filter((point) => !point.predicted);
                  const d = buildLinePath(realPoints.map((point) => ({ x: point.x, y: point.y })));
                  return (
                    <g key={`line-${series.key}`}>
                      <path d={d} stroke={series.color} className="ratioLine" />
                      {points.map((point) => (
                        <circle
                          key={`${series.key}-${point.x}`}
                          cx={point.x}
                          cy={point.y}
                          r={point.predicted ? 3.5 : 4}
                          fill={point.predicted ? 'transparent' : series.color}
                          stroke={series.color}
                          className={point.predicted ? 'ratioPredictedPoint' : 'ratioPoint'}
                        >
                          <title>{`${series.label} | ${point.period} | ${point.value.toFixed(3)}x${point.predicted ? ' (pred)' : ''}`}</title>
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
                  <b>Cohort date {hoveredRatioDetails.period}</b>
                  <ul>
                    {hoveredRatioDetails.details.length > 0 ? (
                      hoveredRatioDetails.details.map((entry) => (
                        <li key={`hover-${entry.label}`}>
                          <span className="hoverLabel" style={{ color: entry.color }}>{entry.label}</span> = {entry.value.toFixed(3)}x{entry.predicted ? ' (pred)' : ''}
                        </li>
                      ))
                    ) : (
                      <li>Sin ratios en este punto.</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="heatmapScroll">
              <table className="heatmap">
                <thead>
                  <tr>
                    <th>Cohort date</th>
                    {availableCohorts.slice(0, -1).map((from, index) => {
                      const to = availableCohorts[index + 1];
                      return <th key={`ratio-${from}-${to}`}>{`${normalizeCohortLabel(from)}→${normalizeCohortLabel(to)}`}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {ratioEvolutionRows.map((row) => (
                    <tr key={`ratio-row-${row.period}`}>
                      <th>{row.period}</th>
                      {availableCohorts.slice(0, -1).map((from, index) => {
                        const to = availableCohorts[index + 1];
                        const key = ratioKey(from, to);
                        const value = row.ratios[key] ?? null;
                        const isPredicted = row.predicted[key] ?? false;
                        return <td key={`ratio-val-${row.period}-${from}`}>{value === null ? 'N/A' : `${isPredicted ? '★ ' : ''}${value.toFixed(3)}x`}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
