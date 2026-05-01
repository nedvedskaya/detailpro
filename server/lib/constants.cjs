// Универсальные временные константы (миллисекунды).
// Заменяют рассыпанные `24 * 60 * 60 * 1000` и т.п. по lib/ и routes/.

const ONE_SECOND_MS      = 1000;
const ONE_MINUTE_MS      = 60 * ONE_SECOND_MS;
const FIVE_MINUTES_MS    = 5  * ONE_MINUTE_MS;
const FIFTEEN_MINUTES_MS = 15 * ONE_MINUTE_MS;
const ONE_HOUR_MS        = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS         = 24 * ONE_HOUR_MS;

module.exports = {
  ONE_SECOND_MS,
  ONE_MINUTE_MS,
  FIVE_MINUTES_MS,
  FIFTEEN_MINUTES_MS,
  ONE_HOUR_MS,
  ONE_DAY_MS,
};
