import { LocaleShell } from "@/components/layout/locale-shell";

export default function DefaultLocaleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LocaleShell locale="en">{children}</LocaleShell>;
}
