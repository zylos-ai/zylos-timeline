import DocsLayout from "../../[locale]/docs/layout";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout params={Promise.resolve({ locale: "en" })}>
      {children}
    </DocsLayout>
  );
}
