import { LandingHero } from "@/components/landing/hero";
import { LandingFeatures } from "@/components/landing/features";
import { TerminalDemo } from "@/components/landing/terminal";
import { LandingFooter } from "@/components/landing/footer";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/lib/i18n/routing";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Meta" });
  return {
    title: t("title"),
    description: t("description"),
  };
}

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20">
      <LandingHero />
      <LandingFeatures />
      <TerminalDemo />
      <LandingFooter />
    </main>
  );
}
