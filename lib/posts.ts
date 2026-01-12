import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { Milestone } from './data';

const contentDirectory = path.join(process.cwd(), 'content');

export function getAllMilestones(): Milestone[] {
    const fileNames = fs.readdirSync(contentDirectory);
    const allMilestonesData = fileNames.map((fileName) => {
        // Remove ".md" from file name to get id (if needed)
        // const id = fileName.replace(/\.md$/, '');

        // Read markdown file as string
        const fullPath = path.join(contentDirectory, fileName);
        const fileContents = fs.readFileSync(fullPath, 'utf8');

        // Use gray-matter to parse the post metadata section
        const { data, content } = matter(fileContents);

        // Combine the data with the id and contentHtml
        // Assuming the frontmatter has date, icon, description
        return {
            date: data.date,
            title: data.title || '', // Fallback or empty if not needed
            description: data.description, // Short description/Summary
            longDescription: content.trim(), // The markdown content becomes longDescription
            icon: data.icon,
            // optional fields that are removed or optional now
            // category: data.category,
            // status: data.status,
        } as Milestone;
    });

    // Sort milestones by date (descending for display, but wait, the timeline component reverses it? 
    // The component said: [...milestones].reverse().map(...)
    // So if we want newest first, we should provide them sorted, or rely on the component.
    // Let's return them strictly sorted by date ascending, so the existing component logic (reverse) works as expected.
    return allMilestonesData.sort((a, b) => {
        if (a.date < b.date) {
            return -1;
        } else {
            return 1;
        }
    });
}
