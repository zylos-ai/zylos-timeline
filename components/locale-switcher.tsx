"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/lib/i18n/navigation";
import { routing } from "@/lib/i18n/routing";

export function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations("LocaleSwitcher");

  return (
    <div className="flex items-center gap-1 text-sm" role="group" aria-label="Language switcher">
      {routing.locales.map((l) => {
        const isCurrent = l === locale;

        if (isCurrent) {
          return (
            <span
              key={l}
              aria-current="true"
              className="px-2 py-1 rounded text-primary font-medium"
            >
              {t(l)}
            </span>
          );
        }

        return (
          <Link
            key={l}
            href={pathname}
            locale={l}
            aria-label={`Switch to ${l === "en" ? "English" : "Chinese"}`}
            className="px-2 py-1 rounded transition-colors text-muted-foreground hover:text-foreground"
          >
            {t(l)}
          </Link>
        );
      })}
    </div>
  );
}
