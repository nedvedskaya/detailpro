#!/usr/bin/env node
'use strict';
/**
 * Прогон retention-cleanup в dry-run режиме.
 *
 * НЕ УДАЛЯЕТ ничего, только показывает кого бы удалил и кому послал бы
 * предупреждение. Удобно прогнать на проде ПЕРЕД тем, как включать
 * автоматический cron, чтобы убедиться, что фильтры выбирают правильно.
 *
 * Запуск (на проде, под root в /var/www/saas-crm):
 *   node scripts/cleanup-dry-run.cjs
 *
 * Если результат устраивает — cron подхватит реальные удаления сам
 * (запускается раз в сутки). Чтобы прогнать реально без cron'а, запусти:
 *   RETENTION_DELETE_ENABLED=true RETENTION_DRY_RUN=false node -e "require('./server/lib/cleanup.cjs').runCleanup({dryRun:false}).then(r=>console.log(JSON.stringify(r,null,2)))"
 *
 * Параметры по умолчанию:
 *   RETENTION_AFTER_EXPIRY_DAYS = 30  (через 30 дней после истечения удаляем)
 *   RETENTION_WARNING_DAYS      = 7   (warning за 7 дней до удаления)
 *   RETENTION_BATCH_LIMIT       = 10  (max 10 удалений за прогон)
 *   RETENTION_WARNING_BATCH     = 50  (max 50 warnings за прогон)
 *
 * Перекрыть можно через ENV перед запуском:
 *   RETENTION_AFTER_EXPIRY_DAYS=14 node scripts/cleanup-dry-run.cjs
 */

try { require('dotenv').config(); } catch (_) { /* нет dotenv — ок */ }

const cleanup = require('../server/lib/cleanup.cjs');

(async () => {
  console.log('=== retention cleanup DRY-RUN ===');
  console.log('config:', cleanup.config);
  console.log('');

  const summary = await cleanup.runCleanup({ dryRun: true });

  console.log('');
  console.log('=== summary ===');
  console.log(JSON.stringify(summary, null, 2));

  if (summary.errors.length > 0) {
    console.error('⚠️  errors during dry-run, see above');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
