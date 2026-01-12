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

- `app/globals.css`: Defines the custom futuristic color palette and theme variables.
- `lib/data.ts`: Contains the timeline data (milestones). Edit this file to add new diary entries.
- `components/hero.tsx`: The landing section with the Zylos title and social links.
- `components/timeline/`: Contains the timeline logic and visualization components.

## 🎨 Design System

The design uses a custom set of CSS variables optimized for a dark, sci-fi interface.
- **Primary Color**: Neon Cyan (Oklch)
- **Secondary Color**: Deep Violet
- **Background**: Deep Void Black (almost pure black with a hint of blue)

---
*Built by [Antigravity] for [Howard]*
