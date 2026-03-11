import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Zylos',
      url: '/',
    },
    githubUrl: 'https://github.com/zylos-ai',
    links: [],
  };
}
