"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/lib/i18n/navigation";
import { routing } from "@/lib/i18n/routing";
import type { Locale } from "next-intl";
import { useRef, useTransition } from "react";

export function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("LocaleSwitcher");
  const [isPending, startTransition] = useTransition();
  const pendingRef = useRef(false);

  function switchLocale(nextLocale: Locale) {
    if (pendingRef.current || nextLocale === locale) return;
    pendingRef.current = true;
    startTransition(() => {
      router.replace(pathname, { locale: nextLocale });
    });
  }

  if (!isPending) {
    pendingRef.current = false;
  }

  return (
    <div className="flex items-center gap-1 text-sm" role="group" aria-label="Language switcher">
      {routing.locales.map((l) => (
        <button
          key={l}
          onClick={() => switchLocale(l)}
          disabled={isPending || locale === l}
          aria-label={`Switch to ${l === "en" ? "English" : "Chinese"}`}
          aria-current={locale === l ? "true" : undefined}
          className={`px-2 py-1 rounded transition-colors ${
            isPending ? "opacity-50 cursor-wait" : ""
          } ${
            locale === l
              ? "text-primary font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t(l)}
        </button>
      ))}
    </div>
  );
}
