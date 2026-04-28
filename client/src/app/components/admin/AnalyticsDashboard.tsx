/**
 * AnalyticsDashboard — раздел «Аналитика» в админ-панели студии.
 *
 * Доступен только role='owner' на тарифе «Студия» (sgt server/routes/admin.cjs).
 * Бэк-эндпоинт GET /api/admin/analytics?period=3m|6m|year отдаёт всё одним
 * объектом (карточки, графики, топ-услуги, ретеншн). Переключение периода
 * → новый запрос → перерисовка.
 *
 * Дизайн: спека analytics_dashboard_spec.md. Цвета — оранжевая палитра
 * #E8480A / #FF8C5A / #FFB38A / #FFD9C2. Графики — recharts (BarChart,
 * LineChart, PieChart) с теми же высотами и закруглениями, что в спеке.
 *
 * Если бэк вернул 402 plan_required (не «Студия») — это нормальная ситуация
 * для не-studio пользователей; вкладка в AdminPanel вообще скрыта в этом
 * случае, но если кто-то постучится напрямую — покажем плашку.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { api, type AnalyticsResponse } from '@/utils/api';
import { handleApiError } from '@/utils/stateHelpers';

// ── Палитра (спека) ──
const ACCENT       = '#E8480A';
const ACCENT_LIGHT = '#FF8C5A';
const ACCENT_PALE  = '#FFB38A';
const ACCENT_GHOST = '#FFD9C2';
const NEUTRAL_GREY = '#D3D1C7'; // для второго ряда «Новые клиенты» в bar-chart

const DONUT_COLORS = [ACCENT, ACCENT_LIGHT, ACCENT_PALE, ACCENT_GHOST, '#FFE7D6', '#FFF0EB'];

type Period = '3m' | '6m' | 'year';

// ── Форматтеры ──
const fmtMoney = (n: number) => `${n.toLocaleString('ru-RU')}\u00A0₽`;
const fmtThousands = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}М`;
  if (n >= 1000) return `${Math.round(n / 1000)}к`;
  return String(n);
};
const fmtDelta = (delta: number, isPercent: boolean) => {
  if (delta === 0) return 'без изменений';
  const sign = delta > 0 ? '+' : '−';
  const val = Math.abs(delta);
  return isPercent ? `${sign} ${val}% к прошлому` : `${sign} ${val} к прошлому`;
};

interface Props {
  /** Сохранён в Props для обратной совместимости (раньше при !studio
   *  показывали upsell-плашку). Сейчас аналитика доступна всем тарифам,
   *  поле игнорируется и оставлено только чтобы не править все вызовы. */
  plan?: string | null;
  /** Не используется — оставлено ради обратной совместимости. */
  onUpgrade?: () => void;
}

export const AnalyticsDashboard = ({ plan: _plan, onUpgrade: _onUpgrade }: Props) => {
  const [period, setPeriod] = useState<Period>('6m');
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getAnalytics(period)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => handleApiError(err, 'Не удалось загрузить аналитику', 'getAnalytics'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <div className="space-y-4">
      {/* ── Шапка: заголовок + переключатель периода ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900">Аналитика студии</h2>
        <PeriodSwitcher value={period} onChange={setPeriod} disabled={loading} />
      </div>

      {/* ── 4 метрик-карточки ── */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <MetricCardAccent
          label="Выручка за месяц"
          value={data ? fmtMoney(data.current_month.revenue) : '—'}
          delta={data ? fmtDelta(data.current_month.revenue_delta_pct, true) : ''}
          loading={loading && !data}
        />
        <MetricCard
          label="Заказов за месяц"
          value={data ? String(data.current_month.orders) : '—'}
          delta={data ? fmtDelta(data.current_month.orders_delta, false) : ''}
          deltaSign={data ? Math.sign(data.current_month.orders_delta) : 0}
          loading={loading && !data}
        />
        <MetricCard
          label="Новых клиентов"
          value={data ? String(data.current_month.new_clients) : '—'}
          delta={data ? fmtDelta(data.current_month.new_clients_delta, false) : ''}
          deltaSign={data ? Math.sign(data.current_month.new_clients_delta) : 0}
          loading={loading && !data}
        />
        <MetricCard
          label="Средний чек"
          value={data ? fmtMoney(data.current_month.avg_check) : '—'}
          delta={data ? fmtDelta(data.current_month.avg_check_delta_pct, true) : ''}
          deltaSign={data ? Math.sign(data.current_month.avg_check_delta_pct) : 0}
          loading={loading && !data}
        />
      </div>

      {/* ── Графики: 2 ряда по 2 (на md+), на мобильном — стопкой ── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RevenueByMonthCard data={data} />
        <OrdersAndClientsCard data={data} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AvgCheckCard data={data} />
        <CategoriesCard data={data} />
      </div>

      {/* ── Топ услуг + Клиентская база ── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TopServicesCard data={data} />
        <RetentionCard data={data} />
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// Переключатель периода (3 пилюли)
// ──────────────────────────────────────────────────────────────────────
interface PeriodSwitcherProps { value: Period; onChange: (v: Period) => void; disabled?: boolean; }
function PeriodSwitcher({ value, onChange, disabled }: PeriodSwitcherProps) {
  const opts: { v: Period; label: string }[] = [
    { v: '3m',   label: '3 мес' },
    { v: '6m',   label: '6 мес' },
    { v: 'year', label: 'Год' },
  ];
  return (
    <div className="flex gap-1.5">
      {opts.map((o) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.v)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              active
                ? 'bg-orange-500 text-white'
                : 'bg-white text-zinc-600 border border-zinc-200 hover:bg-zinc-50'
            } disabled:opacity-60`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Метрик-карточки
// ──────────────────────────────────────────────────────────────────────
function MetricCardAccent({ label, value, delta, loading }: { label: string; value: string; delta: string; loading?: boolean }) {
  return (
    <div className="rounded-lg p-3.5 px-4" style={{ backgroundColor: ACCENT }}>
      <div className="text-xs" style={{ color: 'rgba(255,255,255,0.75)' }}>{label}</div>
      <div className="mt-1 text-[22px] font-medium leading-tight text-white">{loading ? <Skeleton w={80} dark /> : value}</div>
      <div className="mt-1 text-[11px]" style={{ color: 'rgba(255,255,255,0.85)' }}>{loading ? '' : delta}</div>
    </div>
  );
}

function MetricCard({ label, value, delta, deltaSign, loading }: {
  label: string; value: string; delta: string; deltaSign?: number; loading?: boolean;
}) {
  // Цвет дельты: зелёный — рост, красный — падение, серый — без изменений / нет данных.
  const deltaColor = deltaSign === undefined || deltaSign === 0
    ? 'text-zinc-400'
    : deltaSign > 0 ? 'text-green-600' : 'text-red-500';
  return (
    <div className="rounded-lg bg-zinc-50 p-3.5 px-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-[22px] font-medium leading-tight text-zinc-900">{loading ? <Skeleton w={60} /> : value}</div>
      <div className={`mt-1 text-[11px] ${deltaColor}`}>{loading ? '' : delta}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Карточка-обёртка для графиков
// ──────────────────────────────────────────────────────────────────────
function ChartCard({ title, subtitle, children, height }: {
  title: string; subtitle?: string; children: React.ReactNode; height: number;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2">
        <div className="text-sm font-semibold text-zinc-900">{title}</div>
        {subtitle && <div className="text-xs text-zinc-500">{subtitle}</div>}
      </div>
      <div style={{ width: '100%', height }}>
        {children}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// График 1: Выручка по месяцам (bar)
// ──────────────────────────────────────────────────────────────────────
function RevenueByMonthCard({ data }: { data: AnalyticsResponse | null }) {
  const rows = data?.by_month || [];
  return (
    <ChartCard title="Выручка по месяцам" subtitle="Динамика за период, ₽" height={220}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(128,128,128,0.1)" vertical={false} />
          {/*
            interval=0 — показывать ВСЕ метки месяцев (по умолчанию recharts
            прячет «не помещающиеся», и на годовом периоде из 12 точек
            пропадают Июл/Ноя/Янв/Мар).
          */}
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#71717a' }} axisLine={false} tickLine={false} interval={0} />
          <YAxis tickFormatter={fmtThousands} tick={{ fontSize: 11, fill: '#71717a' }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            cursor={{ fill: 'rgba(232,72,10,0.08)' }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e4e4e7', fontSize: 12 }}
            formatter={(v: number) => [fmtMoney(v), 'Выручка']}
          />
          <Bar dataKey="revenue" radius={[5, 5, 0, 0]}>
            {rows.map((_, i) => (
              <Cell key={i} fill={i === rows.length - 1 ? ACCENT : ACCENT_PALE} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ──────────────────────────────────────────────────────────────────────
// График 2: Заказы и клиенты (grouped bar)
// ──────────────────────────────────────────────────────────────────────
function OrdersAndClientsCard({ data }: { data: AnalyticsResponse | null }) {
  const rows = data?.by_month || [];
  return (
    <ChartCard title="Заказы и клиенты" subtitle="По месяцам за период" height={220}>
      <div className="mb-1 flex gap-3 text-[11px] text-zinc-500">
        <LegendDot color={ACCENT} label="Заказы" />
        <LegendDot color={NEUTRAL_GREY} label="Новые клиенты" />
      </div>
      <ResponsiveContainer width="100%" height="92%">
        <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(128,128,128,0.1)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#71717a' }} axisLine={false} tickLine={false} interval={0} />
          <YAxis tick={{ fontSize: 11, fill: '#71717a' }} axisLine={false} tickLine={false} width={32} />
          <Tooltip
            cursor={{ fill: 'rgba(232,72,10,0.08)' }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e4e4e7', fontSize: 12 }}
          />
          <Bar dataKey="orders"      fill={ACCENT}        radius={[4,4,0,0]} name="Заказы" />
          <Bar dataKey="new_clients" fill={NEUTRAL_GREY}  radius={[4,4,0,0]} name="Новые клиенты" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center">
      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// График 3: Средний чек (line)
// ──────────────────────────────────────────────────────────────────────
function AvgCheckCard({ data }: { data: AnalyticsResponse | null }) {
  const rows = data?.by_month || [];
  return (
    <ChartCard title="Средний чек" subtitle="Динамика, ₽" height={220}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(128,128,128,0.1)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#71717a' }} axisLine={false} tickLine={false} interval={0} />
          <YAxis tickFormatter={fmtThousands} tick={{ fontSize: 11, fill: '#71717a' }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            contentStyle={{ borderRadius: 8, border: '1px solid #e4e4e7', fontSize: 12 }}
            formatter={(v: number) => [fmtMoney(v), 'Ср. чек']}
          />
          <Line
            type="monotone"
            dataKey="avg_check"
            stroke={ACCENT}
            strokeWidth={2}
            dot={{ r: 4, fill: ACCENT, stroke: ACCENT }}
            activeDot={{ r: 5 }}
            // recharts эмулирует «fill под линией» через AreaChart, но для соответствия
            // спеке (line c заливкой) используем легкую тень через линию + svg-Area
            // в отдельном слое необязательно — оставляем чистую линию с точками.
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ──────────────────────────────────────────────────────────────────────
// График 4: Структура выручки (donut)
// ──────────────────────────────────────────────────────────────────────
function CategoriesCard({ data }: { data: AnalyticsResponse | null }) {
  const cats = data?.categories || [];
  return (
    <ChartCard title="Структура выручки" subtitle="По категориям за период" height={220}>
      <div className="mb-1 flex flex-wrap gap-2.5 text-[11px] text-zinc-500">
        {cats.slice(0, 6).map((c, i) => (
          <LegendDot key={c.name} color={DONUT_COLORS[i % DONUT_COLORS.length]} label={`${c.name} ${c.pct}%`} />
        ))}
      </div>
      <ResponsiveContainer width="100%" height="86%">
        <PieChart>
          <Pie
            data={cats}
            dataKey="revenue"
            nameKey="name"
            innerRadius="62%"
            outerRadius="92%"
            paddingAngle={0}
            stroke="none"
          >
            {cats.map((_, i) => (
              <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ borderRadius: 8, border: '1px solid #e4e4e7', fontSize: 12 }}
            formatter={(v: number) => [fmtMoney(v), 'Выручка']}
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Топ-5 услуг
// ──────────────────────────────────────────────────────────────────────
function TopServicesCard({ data }: { data: AnalyticsResponse | null }) {
  const items = data?.top_services || [];
  const max = useMemo(() => items.reduce((m, it) => Math.max(m, it.revenue), 0) || 1, [items]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3">
        <div className="text-sm font-semibold text-zinc-900">Топ услуг по выручке</div>
        <div className="text-xs text-zinc-500">За выбранный период</div>
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-sm text-zinc-400">Нет данных за период</div>
      ) : (
        <ol className="divide-y divide-zinc-100">
          {items.map((s, i) => {
            const pct = Math.max(2, Math.round((s.revenue / max) * 100));
            return (
              <li key={s.name + i} className="flex items-center gap-3 py-2.5">
                <span className="w-4 text-[11px] text-zinc-400">{i + 1}</span>
                <span className="flex-1 truncate text-xs text-zinc-900">{s.name}</span>
                <span className="hidden h-1 w-[72px] overflow-hidden rounded-sm bg-zinc-100 sm:block">
                  <span className="block h-full" style={{ width: `${pct}%`, background: ACCENT }} />
                </span>
                <span className="min-w-[80px] text-right text-xs font-medium text-zinc-900">{fmtMoney(s.revenue)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Клиентская база
// ──────────────────────────────────────────────────────────────────────
function RetentionCard({ data }: { data: AnalyticsResponse | null }) {
  const r = data?.retention;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3">
        <div className="text-sm font-semibold text-zinc-900">Клиентская база</div>
        <div className="text-xs text-zinc-500">Показатели удержания</div>
      </div>
      {!r ? (
        <div className="py-6 text-center text-sm text-zinc-400">{data === null ? 'Загрузка…' : 'Нет данных'}</div>
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm">
          <Row label="Всего клиентов" value={String(r.total_clients)} />
          <Row label="Повторных визитов" value={`${r.repeat_pct}%`}
               badge={r.repeat_pct >= 50 ? { tone: 'good', text: 'Хорошо' } : undefined} />
          <Row label="Не приходили 3+ мес" value={String(r.inactive_3m)}
               badge={r.inactive_3m > 0 ? { tone: 'warn', text: 'Внимание' } : undefined} />
          <Row label="Записей на следующий мес" value={String(r.upcoming_next_month)}
               badge={r.upcoming_next_month > 0 ? { tone: 'accent', text: 'Активны' } : undefined} />
          <Row label="Ср. интервал между визитами" value={r.avg_interval_months > 0 ? `${r.avg_interval_months.toString().replace('.', ',')} мес` : '—'} />
          <Row label="Конверсия в повтор (30 дн)" value={`${r.conversion_30d_pct}%`}
               badge={r.conversion_30d_pct < 25 ? { tone: 'warn', text: 'Низко' } : undefined} />
        </ul>
      )}
    </div>
  );
}

function Row({ label, value, badge }: {
  label: string; value: string;
  badge?: { tone: 'good' | 'warn' | 'accent'; text: string };
}) {
  const badgeCls =
    badge?.tone === 'good'   ? 'bg-green-50 text-green-700'   :
    badge?.tone === 'warn'   ? 'bg-amber-50 text-amber-700'   :
    'bg-orange-50 text-orange-800';
  return (
    <li className="flex items-center justify-between py-1.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-zinc-900">{value}</span>
        {badge && (
          <span className={`rounded px-2 py-0.5 text-xs ${badgeCls}`}>{badge.text}</span>
        )}
      </span>
    </li>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Skeleton (плейсхолдер во время первой загрузки)
// ──────────────────────────────────────────────────────────────────────
function Skeleton({ w, dark }: { w: number; dark?: boolean }) {
  return (
    <span
      className={`inline-block h-5 rounded ${dark ? 'bg-white/30' : 'bg-zinc-200'} animate-pulse`}
      style={{ width: w }}
    />
  );
}
