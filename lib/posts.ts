import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { Milestone } from './data';

// Extended interface for Research reports which might have tags
export interface ContentItem extends Milestone {
    tags?: string[];
    slug: string;
}

export function getContent(subdir: string): ContentItem[] {
    const contentDirectory = path.join(process.cwd(), 'content', subdir);

    if (!fs.existsSync(contentDirectory)) {
        return [];
    }

    const fileNames = fs.readdirSync(contentDirectory);
    const allContentData = fileNames.map((fileName) => {
        // Skip if it is not a markdown file
        if (!fileName.endsWith('.md')) {
            return null;
        }

        // Read markdown file as string
        const fullPath = path.join(contentDirectory, fileName);
        const fileContents = fs.readFileSync(fullPath, 'utf8');

        // Use gray-matter to parse the post metadata section
        const { data, content } = matter(fileContents);
        const slug = fileName.replace(/\.md$/, '');

        return {
            slug,
            date: data.date,
            title: data.title || '',
            description: data.description,
            longDescription: content.trim(),
            icon: data.icon,
            tags: data.tags,
        } as ContentItem;
    }).filter((item): item is ContentItem => item !== null);

    // Sort by date descending (newest first)
    return allContentData.sort((a, b) => {
        if (a.date < b.date) {
            return 1;
        } else {
            return -1;
        }
    });
}

export function getPostBySlug(subdir: string, slug: string): ContentItem | null {
    try {
        const fullPath = path.join(process.cwd(), 'content', subdir, `${slug}.md`);
        const fileContents = fs.readFileSync(fullPath, 'utf8');
        const { data, content } = matter(fileContents);

        return {
            slug,
            date: data.date,
            title: data.title || '',
            description: data.description,
            longDescription: content.trim(),
            icon: data.icon,
            tags: data.tags,
        } as ContentItem;
    } catch (e) {
        return null;
    }
}
