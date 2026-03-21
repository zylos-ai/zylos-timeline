import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { Navbar } from '@/components/layout/navbar';

export default async function Layout({ children }: { children: ReactNode }) {
  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={messages} locale="en">
      <Navbar />
      <DocsLayout
        tree={source.getPageTree()}
        nav={{ enabled: false }}
        links={[]}
        sidebar={{
          defaultOpenLevel: 1,
        }}
      >
        {children}
      </DocsLayout>
    </NextIntlClientProvider>
  );
}
