import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Zylos',
      url: '/',
    },
    links: [
      {
        text: 'Features',
        url: '/#features',
      },
      {
        text: 'Evolution',
        url: '/timeline',
      },
      {
        text: 'Research',
        url: '/research',
      },
    ],
  };
}
