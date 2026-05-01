const { ONE_HOUR_MS } = require('./constants.cjs');
'use strict';
/**
 * In-memory rate-limiter.
 *
 * Зачем свой, а не express-rate-limit:
 *   - в auth.cjs уже были две inline-Map'ы с разной семантикой (login по email +
 *     reset-request по email). Легче было вынести общий механизм, чем тащить
 *     зависимость и подгонять её под наш стиль (recordFailure/recordSuccess).
 *
 * Ограничение: state хранится в памяти процесса. При горизонтальном
 * масштабировании (>1 инстанс Node) лимиты по факту умножаются на N инстансов.
 * Для одного VPS это адекватно. При переходе на k8s/несколько реплик
 * заменить хранилище на Redis (интерфейс класса не поменяется).
 *
 * Два режима:
 *   - hit(key)            — фиксированное окно: каждый вызов = +1, при превышении
 *                           блок на blockMs. Для эндпоинтов, где сам факт хита
 *                           = попытка (signup, password-reset request).
 *   - recordFailure/Success — отдельная семантика «попытка vs. результат».
 *                           Удачные запросы счёт обнуляют. Для login.
 */

class FixedWindowLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.max       — максимум хитов в окне
   * @param {number} opts.windowMs  — длина окна
   * @param {number} [opts.blockMs] — длительность блока после превышения (default = windowMs)
   * @param {string} [opts.name]    — для логов
   */
  constructor({ max, windowMs, blockMs, name = 'rl' }) {
    if (!Number.isFinite(max) || max <= 0) throw new Error('rate_limit: max must be > 0');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('rate_limit: windowMs must be > 0');
    this.max = max;
    this.windowMs = windowMs;
    this.blockMs = Number.isFinite(blockMs) && blockMs > 0 ? blockMs : windowMs;
    this.name = name;
    /** @type {Map<string, { firstAt:number, count:number, blockedUntil:number }>} */
    this.records = new Map();
    // Чистка раз в час; unref чтобы не держать процесс живым.
    this._timer = setInterval(() => this._sweep(), ONE_HOUR_MS);
    this._timer.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [k, rec] of this.records) {
      const blockExpired = (rec.blockedUntil || 0) <= now;
      const windowExpired = now - rec.firstAt > this.windowMs;
      if (blockExpired && windowExpired) this.records.delete(k);
    }
  }

  /** Проверить, заблокирован ли ключ. Не инкрементит счётчик. */
  isBlocked(key) {
    const rec = this.records.get(key);
    if (!rec) return false;
    if (rec.blockedUntil && rec.blockedUntil > Date.now()) return true;
    // окно истекло — сбросим запись
    if (Date.now() - rec.firstAt > this.windowMs) {
      this.records.delete(key);
    }
    return false;
  }

  /** Зарегистрировать неудачную попытку (login). При max+ — поставить блок. */
  recordFailure(key) {
    const now = Date.now();
    let rec = this.records.get(key);
    if (!rec || now - rec.firstAt > this.windowMs) {
      rec = { firstAt: now, count: 0, blockedUntil: 0 };
    }
    rec.count += 1;
    if (rec.count >= this.max) rec.blockedUntil = now + this.blockMs;
    this.records.set(key, rec);
  }

  /** Сбросить счётчик после успеха (login OK). */
  recordSuccess(key) {
    this.records.delete(key);
  }

  /**
   * Атомарно: «учесть попытку и сказать, разрешена ли она». Для эндпоинтов,
   * где не различаем успех/неуспех (signup, reset-request).
   * @returns {boolean} true если в пределах лимита, false если превышен.
   */
  hit(key) {
    if (this.isBlocked(key)) return false;
    const now = Date.now();
    let rec = this.records.get(key);
    if (!rec || now - rec.firstAt > this.windowMs) {
      rec = { firstAt: now, count: 0, blockedUntil: 0 };
    }
    rec.count += 1;
    if (rec.count > this.max) {
      rec.blockedUntil = now + this.blockMs;
      this.records.set(key, rec);
      return false;
    }
    this.records.set(key, rec);
    return true;
  }

  /** Для тестов / админ-эндпоинта: текущее состояние. */
  inspect(key) {
    return this.records.get(key) || null;
  }
}

module.exports = { FixedWindowLimiter };
