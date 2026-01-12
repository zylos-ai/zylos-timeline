# Zylos Growth Timeline

A futuristic, single-page website documenting the evolutionary journey of **Zylos**, a personal AI assistant powered by Claude.

## 🌟 Project Overview

This project showcases Zylos's growth from basic scripts to an autonomous agent. It features a high-end, tech-forward aesthetic with smooth animations and a "diary-style" timeline.

### Key Features
- **Futuristic Aesthetic**: Custom "Void Black" theme with Neon Cyan and Deep Violet accents using `oklch` color spaces.
- **Interactive Timeline**: A central, scrolling timeline that reveals diary entries in reverse chronological order (newest first).
- **Glassmorphism**: Premium UI elements with frosted glass effects and subtle glows.
- **Responsive Design**: Optimized layout that adapts from a central spine on desktop to a readable vertical flow on mobile.
- **Tech Stack**:
  - [Next.js 15+](https://nextjs.org/) (App Router)
  - [Tailwind CSS v4](https://tailwindcss.com/)
  - [Framer Motion](https://www.framer.com/motion/) (Animations)
  - [Shadcn/ui](https://ui.shadcn.com/) (Base components)
  - [Lucide React](https://lucide.dev/) (Icons)

## 🚀 Getting Started

1.  **Install dependencies**:
    ```bash
    npm install
    ```

2.  **Run the development server**:
    ```bash
    npm run dev
    ```

3.  **Open the site**:
    Visit [http://localhost:3000](http://localhost:3000)

## 📁 Project Structure

- `content/`: **(NEW)** Contains individual markdown files for each timeline entry.
- `app/globals.css`: Defines the custom futuristic color palette and theme variables.
- `lib/posts.ts`: Utility to read and sort markdown files from the `content` directory.
- `components/hero.tsx`: The landing section with the Zylos title and social links.
- `components/timeline/`: Contains the timeline logic and visualization components.

## 📝 How to Add New Entries

The timeline is powered by Markdown files. To add a new daily log or milestone:

1.  Create a new file in the `content/` folder. Use the date as the filename (e.g., `2026-09-01.md`).
2.  Add the required **Frontmatter** at the top of the file:
    ```markdown
    ---
    date: '2026-09-01'
    icon: 'Brain'  # Options: Cpu, Calendar, Globe, Share2, Brain, Palette, Box
    description: 'A short plain text summary appearing on the timeline card (No Markdown here).'
    ---
    ```
3.  Write your detailed content below the `---`. This supports **Rich Markdown** (headers, lists, code blocks, etc.) and will be shown when the card is expanded.

## 🎨 Design System

The design uses a custom set of CSS variables optimized for a dark, sci-fi interface.
- **Primary Color**: Neon Cyan (Oklch)
- **Secondary Color**: Deep Violet
- **Background**: Deep Void Black (almost pure black with a hint of blue)

---
*Built by [Antigravity] for [Howard]*
