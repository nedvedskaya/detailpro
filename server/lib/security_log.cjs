'use strict';
/**
 * security_log.cjs — структурированный логгер для security-событий.
 *
 * Зачем отдельный модуль:
 *   - Обычный console.log/error пишет фрагменты строк, которые невозможно
 *     грепать и анализировать. Для security важна структура: event type,
 *     IP, userId, route, timestamp.
 *   - journald (systemd default) хранит structured-метаданные через
 *     SYSLOG_IDENTIFIER + одну строку JSON. journalctl -u saas-crm может
 *     грепать по полям через --output=json.
 *
 * Контракт записи:
 *   securityLog({ event, severity, ip, userId, route, ... })
 *   → console.log с префиксом [SEC]: '{"event":"login.failure",...}'
 *
 * Уровни severity:
 *   - INFO     — успешный login, logout, password change (для аудита)
 *   - WARN     — login failure, invalid HMAC, rate-limit hit
 *   - ALERT    — burst-обнаружен, suspicious pattern
 *
 * IP-burst detection:
 *   Считаем 4xx-ответы в скользящем окне на IP. При превышении порога —
 *   логируем burst-событие (один раз за окно, чтобы не спамить).
 *
 * Не пишем в БД:
 *   В prod-сценарии security-события могут возникать сотнями в секунду
 *   при атаке. Запись в Postgres увеличит нагрузку и сделает базу
 *   фактором отказа атаки. journald буферизованный и достаточно быстрый.
 *   Если позже понадобится агрегация — sidecar-агент (vector/fluentbit)
 *   читает journald и шлёт куда нужно.
 */

const { FixedWindowLimiter } = require('./rate_limit.cjs');
const { FIVE_MINUTES_MS } = require('./constants.cjs');

// ──────────────────────────────────────────────────────────────────────
// Базовый логгер
// ──────────────────────────────────────────────────────────────────────
const SEVERITY = Object.freeze({ INFO: 'INFO', WARN: 'WARN', ALERT: 'ALERT' });

/**
 * Записывает security-событие в structured JSON формате.
 *
 * @param {object} fields
 * @param {string} fields.event — 'login.failure' | 'login.success' | ...
 * @param {'INFO'|'WARN'|'ALERT'} [fields.severity='WARN']
 * @param {string} [fields.ip]
 * @param {string} [fields.userId]
 * @param {string} [fields.email] — будет частично замаскирован
 * @param {string} [fields.route]
 * @param {string} [fields.reason]
 * @param {object} [fields.meta] — произвольные доп.поля для контекста
 */
function securityLog(fields) {
  const { email, ...rest } = fields;
  const record = {
    ts: new Date().toISOString(),
    severity: fields.severity || SEVERITY.WARN,
    ...rest,
  };
  // Маскируем email чтобы не светить полные адреса в журнале:
  // 'nedwedskaya@yandex.ru' → 'n***@yandex.ru'. Этого достаточно для
  // корреляции событий по одному пользователю, без раскрытия PII в логах.
  if (typeof email === 'string') {
    record.emailMasked = maskEmail(email);
  }
  // Префикс [SEC] позволяет грепать одной строкой:
  //   journalctl -u saas-crm | grep '\[SEC\]'
  console.log('[SEC] ' + JSON.stringify(record));
}

function maskEmail(email) {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 1) return '*' + domain;
  return local[0] + '***' + domain;
}

// ──────────────────────────────────────────────────────────────────────
// IP-burst detection
//
// Считаем 4xx-ответы на IP. При >50 за 5 минут с одного IP — пишем
// security-event 'ip.burst'. Дальнейшие хиты в этом окне игнорируем
// (один alert на окно, не спамим). Счётчик автоматически сбросится по
// истечению окна — limit'ер сам ротирует записи.
// ──────────────────────────────────────────────────────────────────────
const IP_BURST_THRESHOLD = 50;
const IP_BURST_WINDOW_MS = FIVE_MINUTES_MS;

const ipErrorCounter = new FixedWindowLimiter({
  name: 'ip.burst',
  max: IP_BURST_THRESHOLD,
  windowMs: IP_BURST_WINDOW_MS,
  blockMs: IP_BURST_WINDOW_MS,
});

// Чтобы не дублировать alert: помечаем IP как уже-залогированный в окне.
const alertedIps = new Map(); // ip → ts

/**
 * Express-middleware: после ответа смотрим на статус, если 4xx — учитываем
 * в IP-counter'е. При превышении порога — однократный security-log.
 * Не блокирует никаких запросов (это работа rate_limit.cjs); только
 * наблюдает.
 */
function trackErrorResponse(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode < 400 || res.statusCode >= 500) return;
    const ip = req.ip || req.socket?.remoteAddress;
    if (!ip) return;

    // .hit() возвращает false если превышен лимит — это и есть «burst».
    const allowed = ipErrorCounter.hit(ip);
    if (allowed) return;

    // Дедуп: один alert per IP per window.
    const last = alertedIps.get(ip);
    const now = Date.now();
    if (last && now - last < IP_BURST_WINDOW_MS) return;
    alertedIps.set(ip, now);

    // Чистим старые записи изредка (когда Map > 1000 — иначе ленится).
    if (alertedIps.size > 1000) {
      for (const [k, t] of alertedIps) {
        if (now - t > IP_BURST_WINDOW_MS) alertedIps.delete(k);
      }
    }

    securityLog({
      event: 'ip.burst',
      severity: SEVERITY.ALERT,
      ip,
      meta: {
        threshold: IP_BURST_THRESHOLD,
        window_ms: IP_BURST_WINDOW_MS,
        last_status: res.statusCode,
        last_route: req.method + ' ' + (req.originalUrl || req.url),
      },
    });
  });
  next();
}

module.exports = {
  securityLog,
  trackErrorResponse,
  SEVERITY,
};
