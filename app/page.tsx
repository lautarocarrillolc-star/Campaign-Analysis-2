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

type AggregatedCell = {
  period: string;
  cohort: string;
  roas: number | null;
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
  return cohortKey.replace('all_revenue_total_', '').toUpperCase();
}

export default function Page() {
  const [rows, setRows] = useState<DataRow[]>([]);
  const [availableCohorts, setAvailableCohorts] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [os, setOs] = useState('all');
  const [network, setNetwork] = useState('all');
  const [campaign, setCampaign] = useState('all');

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
    const source = filteredByDate.filter((row) => os === 'all' || row.os === os);
    return optionValues(source, 'network');
  }, [filteredByDate, os]);

  const campaignOptions = useMemo(() => {
    const source = filteredByDate.filter(
      (row) => (os === 'all' || row.os === os) && (network === 'all' || row.network === network)
    );
    return optionValues(source, 'campaign');
  }, [filteredByDate, os, network]);

  useEffect(() => {
    if (os !== 'all' && !osOptions.includes(os)) {
      setOs('all');
    }
  }, [os, osOptions]);

  useEffect(() => {
    if (network !== 'all' && !networkOptions.includes(network)) {
      setNetwork('all');
    }
  }, [network, networkOptions]);

  useEffect(() => {
    if (campaign !== 'all' && !campaignOptions.includes(campaign)) {
      setCampaign('all');
    }
  }, [campaign, campaignOptions]);

  const scopedRows = useMemo(() => {
    return filteredByDate.filter(
      (row) =>
        (os === 'all' || row.os === os) &&
        (network === 'all' || row.network === network) &&
        (campaign === 'all' || row.campaign === campaign)
    );
  }, [filteredByDate, os, network, campaign]);

  const { cells, periods, cohorts, maxRoas } = useMemo(() => {
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

    const computed: AggregatedCell[] = [];
    const periodSet = new Set<string>();
    let currentMax = 0;

    periodAggregation.forEach((values, period) => {
      periodSet.add(period);
      for (const cohort of availableCohorts) {
        const revenue = values.revenueByCohort[cohort] ?? 0;
        const roas = values.cost === 0 ? (revenue > 0 ? null : 0) : revenue / values.cost;
        if (roas !== null) {
          currentMax = Math.max(currentMax, roas);
        }
        computed.push({ period, cohort, roas });
      }
    });

    return {
      cells: computed,
      periods: Array.from(periodSet).sort((a, b) => a.localeCompare(b)),
      cohorts: availableCohorts,
      maxRoas: currentMax
    };
  }, [scopedRows, granularity, availableCohorts]);

  const cellMap = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const cell of cells) {
      map.set(`${cell.period}|||${cell.cohort}`, cell.roas);
    }
    return map;
  }, [cells]);

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

        <label>
          Sistema operativo
          <select value={os} onChange={(event) => setOs(event.target.value)}>
            <option value="all">Todos</option>
            {osOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label>
          Network
          <select value={network} onChange={(event) => setNetwork(event.target.value)}>
            <option value="all">Todas</option>
            {networkOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label>
          Campaña
          <select value={campaign} onChange={(event) => setCampaign(event.target.value)}>
            <option value="all">Todas</option>
            {campaignOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </aside>

      <section className="heatmapWrap">
        <p className="legend">ROAS por cohortes de revenue (D0, D3, D7, D14, D30, etc). Fórmula: cohort_revenue / cost.</p>
        <div className="heatmapScroll">
          <table className="heatmap">
            <thead>
              <tr>
                <th>Cohort</th>
                {periods.map((period) => (
                  <th key={period}>{period}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((cohort) => (
                <tr key={cohort}>
                  <th>{formatCohort(cohort)}</th>
                  {periods.map((period) => {
                    const value = cellMap.get(`${period}|||${cohort}`) ?? null;
                    return (
                      <td key={`${cohort}-${period}`} style={{ backgroundColor: heatmapColor(value, maxRoas) }}>
                        {value === null ? '∞ / N/A' : value.toFixed(2)}
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
