'use client';

import Papa from 'papaparse';
import { useEffect, useMemo, useState } from 'react';

type Granularity = 'daily' | 'weekly' | 'monthly';

type CsvRow = Record<string, string>;

type DataRow = {
  day: Date;
  os: 'android' | 'ios' | 'other';
  network: string;
  campaign: string;
  cost: number;
  revenueByCohort: Record<string, number>;
};

const OS_MAP: Record<string, DataRow['os']> = {
  google_play: 'android',
  app_store: 'ios'
};

function parseNumber(value: string): number {
  const parsed = Number(value);
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
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function heatmapColor(value: number | null, maxRoas: number): string {
  if (value === null) {
    return '#f4f4f5';
  }
  const ratio = maxRoas > 0 ? Math.min(value / maxRoas, 1) : 0;
  const hue = 120 * ratio;
  return `hsl(${hue}, 72%, ${95 - ratio * 45}%)`;
}

function optionValues(rows: DataRow[], field: keyof Pick<DataRow, 'os' | 'network' | 'campaign'>): string[] {
  return Array.from(new Set(rows.map((row) => String(row[field])))).sort((a, b) => a.localeCompare(b));
}

function formatCohort(cohortKey: string): string {
  return `ROAS ${cohortKey.replace('all_revenue_total_', '').toUpperCase()}`;
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
  const [selectedNetworks, setSelectedNetworks] = useState<string[]>([]);
  const [selectedCampaigns, setSelectedCampaigns] = useState<string[]>([]);

  useEffect(() => {
    Papa.parse<CsvRow>('/Campaign data.csv', {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const fields = result.meta.fields ?? [];
        const cohorts = fields
          .filter((field) => field.startsWith('all_revenue_total_'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

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
              network: row.channel?.trim() || 'unknown',
              campaign: row.campaign_network?.trim() || 'unknown',
              cost: parseNumber(row.cost),
              revenueByCohort
            } satisfies DataRow;
          })
          .filter((row): row is DataRow => row !== null)
          .sort((a, b) => a.day.getTime() - b.day.getTime());

        setRows(parsed);
        setAvailableCohorts(cohorts);

        if (parsed.length > 0) {
          setFromDate(parsed[0].day.toISOString().slice(0, 10));
          setToDate(parsed[parsed.length - 1].day.toISOString().slice(0, 10));
        }
      }
    });
  }, []);

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

  const networkOptions = useMemo(() => {
    const source = filteredByDate.filter((row) => matchesSelection(row.os, selectedOs));
    return optionValues(source, 'network');
  }, [filteredByDate, selectedOs]);

  const campaignOptions = useMemo(() => {
    const source = filteredByDate.filter(
      (row) => matchesSelection(row.os, selectedOs) && matchesSelection(row.network, selectedNetworks)
    );
    return optionValues(source, 'campaign');
  }, [filteredByDate, selectedOs, selectedNetworks]);

  useEffect(() => {
    setSelectedOs((current) => current.filter((value) => osOptions.includes(value)));
  }, [osOptions]);

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
        matchesSelection(row.network, selectedNetworks) &&
        matchesSelection(row.campaign, selectedCampaigns)
    );
  }, [filteredByDate, selectedOs, selectedNetworks, selectedCampaigns]);

  const { orderedPeriods, periodCost, periodRoas, maxRoas } = useMemo(() => {
    const periodAggregation = new Map<string, { cost: number; revenueByCohort: Record<string, number> }>();

    for (const row of scopedRows) {
      const period = periodKey(row.day, granularity);
      const current = periodAggregation.get(period) ?? { cost: 0, revenueByCohort: {} };
      current.cost += row.cost;

      for (const cohort of availableCohorts) {
        current.revenueByCohort[cohort] =
          (current.revenueByCohort[cohort] ?? 0) + (row.revenueByCohort[cohort] ?? 0);
      }

      periodAggregation.set(period, current);
    }

    const periods = Array.from(periodAggregation.keys()).sort((a, b) => a.localeCompare(b));
    const costMap = new Map<string, number>();
    const roasMap = new Map<string, number | null>();
    let currentMax = 0;

    periods.forEach((period) => {
      const values = periodAggregation.get(period);
      if (!values) return;
      costMap.set(period, values.cost);

      availableCohorts.forEach((cohort) => {
        const revenue = values.revenueByCohort[cohort] ?? 0;
        const roas = values.cost === 0 ? (revenue > 0 ? null : 0) : revenue / values.cost;
        roasMap.set(`${period}|||${cohort}`, roas);
        if (roas !== null) {
          currentMax = Math.max(currentMax, roas);
        }
      });
    });

    return {
      orderedPeriods: periods,
      periodCost: costMap,
      periodRoas: roasMap,
      maxRoas: currentMax
    };
  }, [scopedRows, granularity, availableCohorts]);

  return (
    <main className="layout">
      <aside className="filters">
        <h1>ROAS Heatmap</h1>

        <label>
          Tipo de fecha
          <select value={granularity} onChange={(event) => setGranularity(event.target.value as Granularity)}>
            <option value="daily">Diario</option>
            <option value="weekly">Semanal</option>
            <option value="monthly">Mensual</option>
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

        <MultiSelect title="Sistema operativo" options={osOptions} selected={selectedOs} onChange={setSelectedOs} />

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
      </aside>

      <section className="heatmapWrap">
        <p className="legend">
          Tabla por Cohort Date: primera columna Cohort date, segunda columna Ad spend y luego ROAS en porcentaje por
          cohort (D0, D3, D7, etc).
        </p>
        <div className="heatmapScroll">
          <table className="heatmap">
            <thead>
              <tr>
                <th>Cohort date</th>
                <th>Ad spend</th>
                {availableCohorts.map((cohort) => (
                  <th key={cohort}>{formatCohort(cohort)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orderedPeriods.map((period) => (
                <tr key={period}>
                  <th>{period}</th>
                  <td>{(periodCost.get(period) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  {availableCohorts.map((cohort) => {
                    const value = periodRoas.get(`${period}|||${cohort}`) ?? null;
                    return (
                      <td key={`${period}-${cohort}`} style={{ backgroundColor: heatmapColor(value, maxRoas) }}>
                        {value === null ? '∞ / N/A' : `${(value * 100).toFixed(1)}%`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

