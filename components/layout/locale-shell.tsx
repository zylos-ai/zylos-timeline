import { Navbar } from "@/components/layout/navbar";
import { RootProvider } from "fumadocs-ui/provider/next";
import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";

interface LocaleShellProps {
  children: React.ReactNode;
  locale: "en" | "zh";
}

export async function LocaleShell({ children, locale }: LocaleShellProps) {
  setRequestLocale(locale);
  const messages = (await import(`../../messages/${locale}.json`)).default;

  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      <RootProvider
        i18n={{
          locale,
          locales: [
            { name: "English", locale: "en" },
            { name: "中文", locale: "zh" },
          ],
        }}
        search={{
          options: {
            type: "static",
            api: "/search.json",
          },
        }}
        theme={{
          defaultTheme: "dark",
          enableSystem: true,
        }}
      >
        <Navbar />
        {children}
      </RootProvider>
    </NextIntlClientProvider>
  );
}
