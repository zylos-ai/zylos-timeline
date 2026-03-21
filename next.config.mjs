import { createMDX } from 'fumadocs-mdx/next';
import createNextIntlPlugin from 'next-intl/plugin';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

const withMDX = createMDX();
const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts');

export default withNextIntl(withMDX(config));
