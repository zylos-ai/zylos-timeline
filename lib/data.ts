export interface Milestone {
  date: string;
  title?: string;
  description: string;
  longDescription?: string;
  category?: 'core' | 'automation' | 'learning' | 'social' | 'creative';
  status?: 'completed' | 'in-progress' | 'planned';
  icon?: string;
}

export const milestones: Milestone[] = [
  {
    date: '2026-01-01',
    title: 'Genesis: Zylos v1.0',
    description: 'Initial system initialization and core architecture setup.',
    longDescription: 'Zylos was born from the need for a personalized, evolving digital assistant. The first version established the core communication protocols, basic context retention, and the ability to interact with the local file system. It was a humble beginning, but the potential was infinite.',
    category: 'core',
    status: 'completed',
    icon: 'Cpu'
  },
  {
    date: '2026-01-15',
    title: 'Autonomous Scheduling',
    description: 'Integration with calendar APIs and deeply understanding time management.',
    longDescription: 'Zylos gained the ability to not just read calendars, but to optimize them. By understanding task priorities and energy levels, Zylos now autonomously schedules deep work blocks and meetings, ensuring maximum productivity without burnout.',
    category: 'automation',
    status: 'completed',
    icon: 'Calendar'
  },
  {
    date: '2026-02-10',
    title: 'Browser Automation Module',
    description: 'Capability to navigate the web, research, and compile data.',
    longDescription: 'The web is a vast resource. Zylos can now spin up headless browsers to perform research, monitor news feeds for specific topics, and even interact with web-based tools that lack public APIs. This expanded its realm of influence significantly.',
    category: 'automation',
    status: 'completed',
    icon: 'Globe'
  },
  {
    date: '2026-03-05',
    title: 'Social Media Integration',
    description: 'Analyzing trends and drafting engagement strategies.',
    longDescription: 'Understanding the pulse of the digital world. Zylos now monitors social platforms to identify emerging trends relevant to its creator. It drafts posts, suggests engagement strategies, and manages response workflows, acting as a digital PR agent.',
    category: 'social',
    status: 'completed',
    icon: 'Share2'
  },
  {
    date: '2026-04-20',
    title: 'Continuous Self-Learning Loop',
    description: 'Implementing recursive feedback loops for code improvement.',
    longDescription: 'The defining moment of true agency. Zylos analyzes its own successful and failed interactions to refine its prompt chains and tool usage strategies. It effectively re-writes its own operational logic to become more efficient over time.',
    category: 'learning',
    status: 'in-progress',
    icon: 'Brain'
  },
  {
    date: '2026-06-01',
    title: 'Creative Synthesis Engine',
    description: 'Generating detailed creative assets and UI designs.',
    longDescription: 'Moving beyond logic into creativity. Zylos will soon be able to generate high-fidelity UI mockups, write creative fiction, and compose music snippets to aid in the creative process of its user.',
    category: 'creative',
    status: 'planned',
    icon: 'Palette'
  },
  {
    date: '2026-08-15',
    title: 'Holographic Interface',
    description: 'Projecting presence into the physical world.',
    longDescription: 'The final frontier for this phase. Zylos will integrate with AR/VR hardware to provide a spatial interface, allowing for "in-room" collaboration and data visualization in 3D space.',
    category: 'core',
    status: 'planned',
    icon: 'Box'
  }
];
