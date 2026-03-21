import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';

export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  return (
    <DocsLayout
      tree={source.getPageTree(locale)}
      nav={{ enabled: false }}
      links={[]}
      sidebar={{
        defaultOpenLevel: 1,
      }}
    >
      {children}
    </DocsLayout>
  );
}
