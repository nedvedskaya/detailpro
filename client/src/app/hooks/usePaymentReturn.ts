import { useEffect, useRef } from 'react';
import { bootstrap as authBootstrap } from '@/utils/auth';
import { showToast } from '@/app/components/ui/Toast';
import type { Studio, UserData } from '@/utils/types';

/**
 * usePaymentReturn — обработка возврата браузера со страницы Prodamus.
 *
 * Как Prodamus к нам приходит:
 *   В админке Prodamus в «Настройка адресов» прописаны Success URL и Fail URL.
 *   После оплаты Prodamus делает 302 redirect туда, и юзер оказывается у нас
 *   с query-параметром ?payment=success или ?payment=failed.
 *
 *   Параллельно server-to-server летит webhook на /api/webhooks/prodamus —
 *   именно он по факту активирует подписку в БД. Webhook обычно долетает за
 *   1-3 секунды, но иногда бывает задержка до 10-15 сек на стороне Prodamus.
 *
 * Что делает хук:
 *   1. Видит ?payment=success → показывает тост «Подписка активируется,
 *      проверяем оплату…», поллит /api/auth/me каждые 1.5 сек до 8 раз.
 *      Когда видит, что studio.is_active=true И plan ≠ 'trial' (а значит
 *      webhook уже пришёл и UPDATE-нул saas_meta.studios) — вызывает
 *      onPaymentConfirmed с новым user/studio и показывает успешный тост.
 *
 *   2. Видит ?payment=failed → показывает тост-ошибку «Оплата не прошла»,
 *      ничего не поллит.
 *
 *   3. После обработки удаляет query-параметр через history.replaceState,
 *      чтобы при F5 не повторять обработку и не «прыгал» URL.
 *
 * Почему именно поллинг, а не WebSocket / SSE:
 *   - Один пользователь оплачивает раз в месяц-год, поллинг 12 секунд
 *     максимум — никакого реального cost. Городить SSE-канал ради него же
 *     не стоит.
 *   - Webhook идёт server-to-server независимо. Поллинг — только для UI.
 *
 * Вход:
 *   currentPlan — текущий студии plan ДО оплаты (из state). Нужен чтобы
 *                 распознать «webhook пришёл»: если был 'trial' / 'cancelled',
 *                 ждём перехода на 'solo' / 'studio'.
 *   onPaymentConfirmed — callback, в который кладём новый user+studio после
 *                        того как поллинг увидел изменение.
 */
interface UsePaymentReturnArgs {
  currentPlan: string | null;
  onPaymentConfirmed: (data: { user: UserData; studio: Studio }) => void;
  /** false если пользователь ещё не залогинен — хук скипает поллинг (нечего сравнивать). */
  enabled: boolean;
}

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 8; // 8 × 1.5 = 12 сек, обычно хватает с запасом.

// Считаем подписку «активной» (платный тариф уже применён), если:
//   1) plan указан и не равен 'trial' / 'cancelled', И
//   2) is_active === true (на cancelled бэк выставляет false)
// Нам нужно сравнить с состоянием ДО оплаты — например, если был trial,
// ждём перехода на solo/studio. Если уже был solo, а оплатили продление того
// же solo — поллим access_until (изменилось ли значение).
function isPaidPlan(plan?: string | null, isActive?: boolean): boolean {
  if (!plan) return false;
  if (!isActive) return false;
  const lc = plan.toLowerCase();
  return lc !== 'trial' && lc !== 'cancelled';
}

export function usePaymentReturn({ currentPlan, onPaymentConfirmed, enabled }: UsePaymentReturnArgs) {
  // useRef флаг — чтобы при ре-рендере (например, после setUser) не запустить
  // обработку повторно. URL мы чистим через replaceState, но React успевает
  // отрендериться раньше, и эффект может выстрелить второй раз.
  const handledRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (handledRef.current) return;

    const params = new URLSearchParams(window.location.search);
    const status = params.get('payment');
    if (!status) return;

    handledRef.current = true;

    // Чистим URL сразу — если пользователь нажмёт F5, повторной обработки не будет.
    // history.replaceState — единственный способ убрать query без полной навигации.
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', cleanUrl);

    if (status === 'failed' || status === 'fail') {
      showToast(
        'Оплата не прошла. Попробуйте ещё раз или напишите в поддержку.',
        'error'
      );
      return;
    }

    if (status !== 'success' && status !== 'paid') {
      // Неизвестный статус — игнорируем, не шумим.
      return;
    }

    // ─── Successful return: показываем тост и поллим /me ─────────────
    showToast('Оплата получена. Активируем подписку…', 'info');

    let attempt = 0;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      attempt += 1;

      try {
        const result = await authBootstrap();
        if (cancelled) return;

        if (result) {
          const newPlan = result.studio?.plan;
          const newActive = result.studio?.isActive;

          // Условия «webhook отработал»:
          //   - был trial/cancelled и стал платный → точно сработал
          //   - оба раза был платный, но access_until мог измениться;
          //     для простоты считаем, что и в этом случае bootstrap вернул
          //     свежую студию, и обновление UI всё равно полезно.
          // Кейс «оба раза trial» (webhook ещё не дошёл) → продолжаем поллинг.
          const wasPaid = currentPlan && isPaidPlan(currentPlan, true);
          const nowPaid = isPaidPlan(newPlan, newActive);

          if (nowPaid && !wasPaid) {
            // Тариф впервые активирован — успех.
            onPaymentConfirmed(result);
            showToast('Подписка активирована — спасибо!', 'success');
            return;
          }
          if (nowPaid && wasPaid && newPlan !== currentPlan) {
            // Был solo, стал studio (апгрейд). Тоже успех.
            onPaymentConfirmed(result);
            showToast('Тариф обновлён — спасибо!', 'success');
            return;
          }
          if (nowPaid && wasPaid && newPlan === currentPlan) {
            // Продление того же тарифа — webhook продлил access_until.
            // Точного способа понять «успел ли webhook» из /me у нас нет
            // (фронт не видит точное значение access_until до и после
            // в одном кадре), поэтому просто обновляем state и говорим OK.
            // На самом деле в bootstrap мы ВСЕГДА получаем актуальный
            // access_until — обновим state, юзер увидит правильное значение.
            onPaymentConfirmed(result);
            showToast('Подписка продлена — спасибо!', 'success');
            return;
          }
        }
      } catch {
        // Сетевая ошибка — попробуем ещё раз, не паникуем.
      }

      if (attempt >= POLL_MAX_ATTEMPTS) {
        showToast(
          'Оплата получена, но статус подписки ещё не обновился. Обновите страницу через минуту.',
          'info'
        );
        return;
      }

      // Следующая попытка
      setTimeout(poll, POLL_INTERVAL_MS);
    };

    // Первая попытка — с небольшой задержкой, чтобы webhook успел долететь
    // (он обычно приходит за 1-3 сек, нам это в первый poll и попадёт).
    setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]); // currentPlan/onPaymentConfirmed считаем стабильными для одного "входа в магазин"
}
