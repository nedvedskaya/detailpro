
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import "./styles/index.css";

  // Реферальный код из URL `?ref=ABC12345` — сохраняем в localStorage до первого
  // успешного signup. Если пользователь сначала погуляет по сайту, а потом
  // зарегистрируется — код всё равно подтянется в payload.
  // Чистим URL после захвата, чтобы код не утёк в скриншоты/share.
  //
  // Аналогично — `?tg=<token>` для сценария «бот → сайт». Бот выдаёт
  // одноразовый токен (saas_meta.tg_signup_tokens, TTL 30 минут) и шлёт ссылку
  // на /?tg=<token>. На signup-е токен отправляется в /api/auth/signup как
  // `tgSignupToken`, и бэк линкует tg_user_id/tg_chat_id/tg_username из строки
  // токена. Если signup не начат сразу — токен лежит в localStorage и применится
  // при следующей попытке (если ещё не expired — сервер сам это проверит).
  try {
    const params = new URLSearchParams(window.location.search);
    let cleaned = false;

    const ref = params.get('ref');
    if (ref && /^[A-Z0-9]{4,16}$/i.test(ref)) {
      localStorage.setItem('ugt_referral_code', ref.toUpperCase());
      params.delete('ref');
      cleaned = true;
    }

    const tg = params.get('tg');
    if (tg && /^[A-Za-z0-9_-]{16,200}$/.test(tg)) {
      localStorage.setItem('ugt_tg_signup_token', tg);
      params.delete('tg');
      cleaned = true;
    }

    if (cleaned) {
      const qs = params.toString();
      const cleanUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
  } catch (_) { /* localStorage недоступен в инкогнито/iframe — не критично */ }

  createRoot(document.getElementById("root")!).render(<App />);
