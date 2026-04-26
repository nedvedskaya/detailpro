/// <reference types="vite/client" />

// Расширение env-переменных Vite для типобезопасного import.meta.env.*
interface ImportMetaEnv {
  // Ссылка на оплату Продамус «Повысить тариф» (см. ProfilePage).
  // Пока на старте — может быть пустой; CTA тогда показывает alert.
  readonly VITE_PRODAMUS_UPGRADE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
