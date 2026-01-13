import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { Milestone } from './data';

// Extended interface for Research reports which might have tags
export interface ContentItem extends Milestone {
    tags?: string[];
    slug: string;
}

export function getContent(subdir: string, metadataOnly: boolean = false): ContentItem[] {
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
        const stats = fs.statSync(fullPath);

        // Use gray-matter to parse the post metadata section
        const { data, content } = matter(fileContents);
        const slug = fileName.replace(/\.md$/, '');

        return {
            slug,
            date: data.date,
            title: data.title || '',
            description: data.description,
            // Only include full content if not metadata-only mode
            longDescription: metadataOnly ? '' : content.trim(),
            icon: data.icon,
            tags: data.tags,
            _mtime: stats.mtimeMs, // File modification time for sorting
        } as ContentItem & { _mtime: number };
    }).filter((item): item is ContentItem & { _mtime: number } => item !== null);

    // Sort by date descending (newest first), then by file mtime for same-day articles
    return allContentData.sort((a, b) => {
        if (a.date !== b.date) {
            return a.date < b.date ? 1 : -1;
        }
        // Same date: sort by file modification time (newest first)
        return b._mtime - a._mtime;
    }).map(({ _mtime, ...item }) => item as ContentItem); // Remove _mtime from final output
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
