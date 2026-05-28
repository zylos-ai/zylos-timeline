import { MetadataRoute } from 'next';
import { getContent } from '@/lib/posts';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
    const baseUrl = 'https://zylos.ai';
    const locales = ['', '/zh'];

    // Get all research articles
    const researchPosts = getContent('research', true);
    const researchUrls = researchPosts.flatMap((post) => locales.map((locale) => ({
        url: `${baseUrl}${locale}/research/${post.slug}`,
        lastModified: new Date(post.date),
        changeFrequency: 'monthly' as const,
        priority: 0.7,
    })));

    // Static pages
    const pages = [
        {
            path: '',
            lastModified: new Date(),
            changeFrequency: 'daily' as const,
            priority: 1.0,
        },
        {
            path: '/research',
            lastModified: new Date(),
            changeFrequency: 'daily' as const,
            priority: 0.9,
        },
        {
            path: '/privacy',
            lastModified: new Date('2026-01-13'),
            changeFrequency: 'yearly' as const,
            priority: 0.3,
        },
        {
            path: '/terms',
            lastModified: new Date('2026-01-13'),
            changeFrequency: 'yearly' as const,
            priority: 0.3,
        },
    ];
    const staticPages = pages.flatMap((page) => locales.map((locale) => ({
        url: `${baseUrl}${locale}${page.path}`,
        lastModified: page.lastModified,
        changeFrequency: page.changeFrequency,
        priority: page.priority,
    })));

    return [...staticPages, ...researchUrls];
}
